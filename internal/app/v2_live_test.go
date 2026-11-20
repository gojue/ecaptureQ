// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ws "github.com/coder/websocket"
	pb "github.com/gojue/ecapture/v2/protobuf/gen/v2"
	"google.golang.org/protobuf/proto"
)

func nativeEntry(format string, data []byte) *pb.LogEntry {
	event := &pb.Event{CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_KEYLOG, Content: &pb.Event_Keylog{Keylog: &pb.KeylogEvent{Data: data}}}
	if format == "pcapng" {
		event = &pb.Event{CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_PCAPNG, Content: &pb.Event_Pcapng{Pcapng: &pb.PcapngEvent{Data: data}}}
	}
	return &pb.LogEntry{Module: "future-module", LogType: pb.LogType_LOG_TYPE_EVENT, Payload: &pb.LogEntry_EventPayload{EventPayload: event}}
}
func writeV2(t *testing.T, c *ws.Conn, e *pb.LogEntry) {
	t.Helper()
	b, err := proto.Marshal(e)
	if err != nil {
		t.Error(err)
		return
	}
	if err = c.Write(context.Background(), ws.MessageBinary, b); err != nil {
		t.Error(err)
	}
}

// This intentionally non-default route verifies that explicitly configured
// subscription paths are preserved. Real E2E and fixture defaults use root.
func v2Server(t *testing.T, handler func(*ws.Conn)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/custom-subscription" || r.Header.Get("Origin") == "" || r.Header.Get("Sec-WebSocket-Protocol") != "ecapture.v2" {
			t.Error("incorrect v2 handshake/path")
			http.Error(w, "bad", 400)
			return
		}
		c, err := ws.Accept(w, r, &ws.AcceptOptions{Subprotocols: []string{"ecapture.v2"}, OriginPatterns: []string{"localhost"}})
		if err != nil {
			t.Error(err)
			return
		}
		defer c.CloseNow()
		handler(c)
	}))
}
func startV2Store(t *testing.T, server *httptest.Server) (*Store, context.CancelFunc) {
	t.Helper()
	o := liveTestOptions("ws" + strings.TrimPrefix(server.URL, "http") + "/custom-subscription")
	o.ReconnectDelay = time.Hour
	o.MaxReconnectWait = time.Hour
	s, err := NewStore(o)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	t.Cleanup(func() { stopStore(t, s, cancel) })
	return s, cancel
}

func TestV2NativeCloseAndFragmentation(t *testing.T) {
	for _, format := range []string{"keylog", "pcapng"} {
		for _, code := range []ws.StatusCode{ws.StatusNormalClosure, ws.StatusInternalError, 0} {
			t.Run(format+"/"+code.String(), func(t *testing.T) {
				payload := []byte("CLIENT_RANDOM " + strings.Repeat("01", 32) + " " + strings.Repeat("02", 48) + "\n")
				if format == "pcapng" {
					var b bytes.Buffer
					for _, n := range []uint32{0x0a0d0d0a, 28, 0x1a2b3c4d, 1, 0xffffffff, 0xffffffff, 28, 1, 20, 1, 65535, 20} {
						_ = binary.Write(&b, binary.LittleEndian, n)
					}
					payload = b.Bytes()
				}
				server := v2Server(t, func(c *ws.Conn) {
					writeV2(t, c, &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: "not file bytes"}})
					for pos := 0; pos < len(payload); pos += 7 {
						writeV2(t, c, nativeEntry(format, payload[pos:min(pos+7, len(payload))]))
					}
					writeV2(t, c, &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_HEARTBEAT, Payload: &pb.LogEntry_HeartbeatPayload{HeartbeatPayload: &pb.Heartbeat{}}})
					if code != 0 {
						_ = c.Close(code, "fixture end")
					}
				})
				defer server.Close()
				s, _ := startV2Store(t, server)
				awaitStore(t, s, func(st Status) bool { return len(st.Artifacts) == 1 && st.Artifacts[0].State != "receiving" })
				st := s.Status()
				a := st.Artifacts[0]
				want := "partial"
				if code == ws.StatusNormalClosure {
					want = "complete"
				}
				if a.State != want || a.Bytes != int64(len(payload)) || a.Module != "future-module" || st.Retained != 0 {
					t.Fatalf("bad artifact: %+v", a)
				}
				if strings.HasSuffix(a.Filename, ".partial") != (want == "partial") {
					t.Fatal("incorrect file completion name")
				}
				r, err := s.OpenArtifact(st.Session, a.ID)
				if err != nil {
					t.Fatal(err)
				}
				defer r.Close()
				got, err := io.ReadAll(r)
				if err != nil || !bytes.Equal(got, payload) {
					t.Fatal("native bytes altered", err)
				}
			})
		}
	}
}

func TestV2RejectsMalformedAndFormatSwitch(t *testing.T) {
	for _, kind := range []string{"text", "protobuf", "enum", "oneof", "length", "sensitivity", "switch", "module", "format", "empty-native", "content-oneof", "content-missing"} {
		t.Run(kind, func(t *testing.T) {
			accepted := syntheticKeylog()
			server := v2Server(t, func(c *ws.Conn) {
				writeV2(t, c, nativeEntry("keylog", accepted))
				switch kind {
				case "text":
					_ = c.Write(context.Background(), ws.MessageText, []byte("forbidden"))
				case "protobuf":
					_ = c.Write(context.Background(), ws.MessageBinary, []byte{0xff})
				case "enum":
					writeV2(t, c, &pb.LogEntry{LogType: 99})
				case "oneof":
					writeV2(t, c, &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_EVENT, Payload: &pb.LogEntry_RunLog{RunLog: "wrong"}})
				case "length":
					e := testEvent("x")
					e.GetEventPayload().GetText().Length++
					writeV2(t, c, e)
				case "sensitivity":
					e := testEvent("x")
					e.GetEventPayload().GetText().Sensitivity = 99
					writeV2(t, c, e)
				case "switch":
					writeV2(t, c, nativeEntry("pcapng", []byte("not appended")))
				case "module":
					e := nativeEntry("keylog", []byte("not appended"))
					e.Module = strings.Repeat("x", 257)
					writeV2(t, c, e)
				case "format":
					e := nativeEntry("keylog", []byte("not appended"))
					e.GetEventPayload().CaptureFormat = 99
					writeV2(t, c, e)
				case "empty-native":
					writeV2(t, c, nativeEntry("keylog", nil))
				case "content-oneof":
					e := nativeEntry("pcapng", []byte("not appended"))
					e.GetEventPayload().CaptureFormat = pb.CaptureFormat_CAPTURE_FORMAT_KEYLOG
					writeV2(t, c, e)
				case "content-missing":
					e := nativeEntry("keylog", nil)
					e.GetEventPayload().Content = nil
					writeV2(t, c, e)
				}
				_ = c.Close(ws.StatusNormalClosure, "cannot repair prior violation")
			})
			defer server.Close()
			s, _ := startV2Store(t, server)
			awaitStore(t, s, func(st Status) bool {
				return st.Malformed == 1 && len(st.Artifacts) == 1 && st.Artifacts[0].State != "receiving"
			})
			st := s.Status()
			if st.Artifacts[0].State == "complete" || st.Retained != 0 {
				t.Fatal("invalid stream completed")
			}
			info := st.Artifacts[0]
			if info.Bytes != int64(len(accepted)) || !strings.HasSuffix(info.Filename, ".partial") {
				t.Fatal("invalid message changed native artifact", info)
			}
			r, err := s.OpenArtifact(st.Session, info.ID)
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(r)
			_ = r.Close()
			if err != nil || !bytes.Equal(got, accepted) {
				t.Fatal("invalid message polluted native bytes", err)
			}
		})
	}
}

func TestV2RequiresNegotiatedSubprotocol(t *testing.T) {
	for _, mode := range []string{"missing", "wrong"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "wrong" {
					w.Header().Set("Sec-WebSocket-Protocol", "ecapture.v1")
					http.Error(w, "wrong protocol", 400)
					return
				}
				c, err := ws.Accept(w, r, &ws.AcceptOptions{OriginPatterns: []string{"localhost"}})
				if err != nil {
					return
				}
				defer c.CloseNow()
				_, _, _ = c.Read(context.Background())
			}))
			defer server.Close()
			s, _ := startV2Store(t, server)
			awaitStore(t, s, func(st Status) bool { return st.Sources[0].Retries > 0 })
			st := s.Status()
			if st.Sources[0].Generation != 0 || !strings.Contains(st.Sources[0].LastError, "protocol") {
				t.Fatalf("handshake accepted: %+v", st.Sources[0])
			}
		})
	}
}
