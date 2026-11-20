// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	pb "github.com/gojue/ecapture/v2/protobuf/gen/v2"
	"github.com/gojue/ecaptureq/frontend"
	"github.com/gojue/ecaptureq/internal/app"
	"github.com/gojue/ecaptureq/internal/auth"
	"google.golang.org/protobuf/proto"
)

func syntheticNative(format string) []byte {
	if format == "keylog" {
		return []byte("CLIENT_RANDOM " + strings.Repeat("01", 32) + " " + strings.Repeat("02", 48) + "\n")
	}
	var out bytes.Buffer
	block := func(kind uint32, body []byte) {
		_ = binary.Write(&out, binary.LittleEndian, kind)
		_ = binary.Write(&out, binary.LittleEndian, uint32(12+len(body)))
		out.Write(body)
		_ = binary.Write(&out, binary.LittleEndian, uint32(12+len(body)))
	}
	shb := make([]byte, 16)
	binary.LittleEndian.PutUint32(shb, 0x1a2b3c4d)
	binary.LittleEndian.PutUint16(shb[4:], 1)
	binary.LittleEndian.PutUint64(shb[8:], ^uint64(0))
	block(0x0a0d0d0a, shb)
	idb := make([]byte, 8)
	binary.LittleEndian.PutUint16(idb, 1)
	binary.LittleEndian.PutUint32(idb[4:], 65535)
	block(1, idb)
	block(6, make([]byte, 20))
	return out.Bytes()
}

func nativeService(t *testing.T, format string, closeCode websocket.StatusCode) (*app.Service, []byte) {
	t.Helper()
	data := syntheticNative(format)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"ecapture.v2"}, OriginPatterns: []string{"localhost"}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		send := func(entry *pb.LogEntry) bool {
			wire, err := proto.Marshal(entry)
			if err != nil {
				t.Error(err)
				return false
			}
			return conn.Write(r.Context(), websocket.MessageBinary, wire) == nil
		}
		if !send(&pb.LogEntry{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Module: "tls", Payload: &pb.LogEntry_RunLog{RunLog: "synthetic runtime log, not native data"}}) {
			return
		}
		for offset := 0; offset < len(data); offset += 11 {
			chunk := data[offset:min(offset+11, len(data))]
			event := &pb.Event{CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_KEYLOG, Content: &pb.Event_Keylog{Keylog: &pb.KeylogEvent{Data: chunk}}}
			if format == "pcapng" {
				event = &pb.Event{CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_PCAPNG, Content: &pb.Event_Pcapng{Pcapng: &pb.PcapngEvent{Data: chunk}}}
			}
			if !send(&pb.LogEntry{LogType: pb.LogType_LOG_TYPE_EVENT, Module: "future-module", Payload: &pb.LogEntry_EventPayload{EventPayload: event}}) {
				return
			}
		}
		if !send(&pb.LogEntry{LogType: pb.LogType_LOG_TYPE_HEARTBEAT, Payload: &pb.LogEntry_HeartbeatPayload{HeartbeatPayload: &pb.Heartbeat{Count: 999}}}) {
			return
		}
		if closeCode != 0 {
			_ = conn.Close(closeCode, "synthetic end")
		}
	}))
	t.Cleanup(source.Close)
	opts := app.DefaultOptions()
	opts.Mode = "live"
	opts.Native.Dir = t.TempDir()
	opts.ReconnectDelay = time.Hour
	opts.MaxReconnectWait = time.Hour
	opts.Endpoints = []string{"ws" + strings.TrimPrefix(source.URL, "http") + "/custom-subscription"}
	service, err := app.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	service.Start(context.Background())
	deadline := time.Now().Add(5 * time.Second)
	for {
		items := service.Store().Artifacts()
		if len(items) == 1 && items[0].State != "receiving" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("native stream did not finish: %+v %+v", items, service.Store().Status())
		}
		time.Sleep(time.Millisecond)
	}
	return service, data
}

func TestNativeDownloadsThroughActualReceiveAndMountedHTTP(t *testing.T) {
	for _, format := range []string{"keylog", "pcapng"} {
		for _, code := range []websocket.StatusCode{websocket.StatusNormalClosure, websocket.StatusInternalError, 0} {
			t.Run(fmt.Sprintf("%s/%d", format, code), func(t *testing.T) {
				service, data := nativeService(t, format, code)
				status := service.Store().Status()
				if status.Retained != 0 {
					t.Fatal("native fragments entered record mapper")
				}
				info := status.Artifacts[0]
				if info.Module != "future-module" || info.Bytes != int64(len(data)) || info.Generation != 1 {
					t.Fatal(info)
				}
				if code == websocket.StatusNormalClosure {
					if info.State != "complete" || strings.HasSuffix(info.Filename, ".partial") {
						t.Fatal(info)
					}
				} else if info.State != "partial" || !strings.HasSuffix(info.Filename, ".partial") {
					t.Fatal(info)
				}
				for _, base := range []string{"/", "/ecaptureq-web/"} {
					shared, err := New(app.DefaultOptions(), service.Store(), frontend.Files, Policy{})
					if err != nil {
						t.Fatal(err)
					}
					h, err := Mount(base, shared)
					if err != nil {
						t.Fatal(err)
					}
					query := url.Values{"session": {status.Session}, "id": {info.ID}}
					route := base + "api/artifacts/download?" + query.Encode()
					w := httptest.NewRecorder()
					h.ServeHTTP(w, httptest.NewRequest("GET", route, nil))
					if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) || !strings.Contains(w.Header().Get("Content-Disposition"), info.Filename) || w.Header().Get("Cache-Control") != "no-store" {
						t.Fatalf("download %d %v", w.Code, w.Header())
					}
					w = httptest.NewRecorder()
					h.ServeHTTP(w, httptest.NewRequest("HEAD", route, nil))
					if w.Code != 200 || w.Body.Len() != 0 {
						t.Fatal("HEAD included data")
					}
					r := httptest.NewRequest("GET", route, nil)
					r.Header.Set("Range", "bytes=1-6")
					w = httptest.NewRecorder()
					h.ServeHTTP(w, r)
					if w.Code != 206 || !bytes.Equal(w.Body.Bytes(), data[1:7]) {
						t.Fatal("binary range changed data")
					}
					for _, tc := range []struct {
						session, id, origin string
						want                int
					}{{"wrong", info.ID, "", 404}, {status.Session, "../secret", "", 404}, {status.Session, strings.Repeat("f", 32), "", 404}, {status.Session, info.ID, "https://foreign.test", 403}} {
						q := url.Values{"session": {tc.session}, "id": {tc.id}}
						r := httptest.NewRequest("GET", base+"api/artifacts/download?"+q.Encode(), nil)
						r.Header.Set("Origin", tc.origin)
						w := httptest.NewRecorder()
						h.ServeHTTP(w, r)
						if w.Code != tc.want {
							t.Fatalf("access check: %d want %d", w.Code, tc.want)
						}
					}
				}
			})
		}
	}
}

func TestNativeDownloadUsesWebAuthentication(t *testing.T) {
	service, data := nativeService(t, "keylog", websocket.StatusNormalClosure)
	info := service.Store().Artifacts()[0]
	shared, _ := New(app.DefaultOptions(), service.Store(), frontend.Files, Policy{})
	hash, err := auth.HashPassword("synthetic-native-password")
	if err != nil {
		t.Fatal(err)
	}
	protected, err := auth.New(auth.Config{Username: "tester", PasswordHash: hash}, "/", frontend.Files, shared, (Policy{}).ValidOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer protected.Close()
	route := "https://example.test/api/artifacts/download?" + url.Values{"session": {info.Session}, "id": {info.ID}}.Encode()
	w := httptest.NewRecorder()
	protected.ServeHTTP(w, httptest.NewRequest("GET", route, nil))
	if w.Code != 401 {
		t.Fatal("native file bypassed auth")
	}
	r := httptest.NewRequest("POST", "https://example.test/api/auth/login", strings.NewReader(`{"username":"tester","password":"synthetic-native-password"}`))
	r.Header.Set("Origin", "https://example.test")
	r.Header.Set("X-Ecapture-UI", "1")
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	protected.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	r = httptest.NewRequest("GET", route, nil)
	r.AddCookie(w.Result().Cookies()[0])
	w = httptest.NewRecorder()
	protected.ServeHTTP(w, r)
	got, err := io.ReadAll(w.Result().Body)
	if err != nil || w.Code != 200 || !bytes.Equal(got, data) {
		t.Fatal("authorized binary download failed")
	}
}

type cancelAfterChunk struct {
	bytes.Buffer
	cancel context.CancelFunc
}

func (w *cancelAfterChunk) Write(data []byte) (int, error) {
	n, err := w.Buffer.Write(data)
	w.cancel()
	return n, err
}

func TestNativeStreamingStopsOnRevokedRequestContext(t *testing.T) {
	data := bytes.Repeat([]byte{0, 0xff, 1, 2}, 64<<10)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	source := contextReadSeeker{ctx: ctx, ReadSeeker: bytes.NewReader(data)}
	destination := &cancelAfterChunk{cancel: cancel}
	// Hide Buffer.ReadFrom so io.Copy must use the cancellable stream boundary.
	_, err := io.Copy(struct{ io.Writer }{destination}, source)
	if !errors.Is(err, context.Canceled) || destination.Len() == 0 || destination.Len() >= len(data) {
		t.Fatalf("download ignored cancellation: bytes=%d err=%v", destination.Len(), err)
	}
	if _, err := source.Seek(0, io.SeekStart); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled range seek accepted")
	}
}
