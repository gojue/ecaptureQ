// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// ws-fixture is synthetic UI validation data, never a capture implementation.
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"encoding/binary"
	"github.com/coder/websocket"
	pb "github.com/gojue/ecapture/v2/protobuf/gen/v2"
	"google.golang.org/protobuf/proto"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:28359", "Synthetic WebSocket source listen address")
	disconnectAfter := flag.Int("disconnect-after", 0, "Disconnect after N completed synthetic request/response pairs (0: continue)")
	format := flag.String("format", "text", "text, keylog or pcapng")
	path := flag.String("path", "/", "WebSocket path (matches eCapture root path by default)")
	closeCode := flag.Int("close-code", 1000, "Close code after finite stream (1000 or 1011; 0 for EOF)")
	fragment := flag.Int("fragment-size", 7, "Native bytes per binary message")
	module := flag.String("module", "tls", "Synthetic upstream module")
	flag.Parse()
	if (*format != "text" && *format != "keylog" && *format != "pcapng") || *fragment < 1 || *fragment > 8<<20 || (*closeCode != 1000 && *closeCode != 1011 && *closeCode != 0) {
		log.Fatal("invalid fixture options")
	}
	if *disconnectAfter < 0 || flag.NArg() != 0 {
		log.Fatal("disconnect-after must be nonnegative; positional arguments are not accepted")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var connections atomic.Uint64
	server := &http.Server{Addr: *addr, ReadHeaderTimeout: 5 * time.Second}
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != *path {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Sec-WebSocket-Protocol") != "ecapture.v2" || r.Header.Get("Origin") == "" {
			http.Error(w, "ecapture.v2 and Origin required", http.StatusBadRequest)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"ecapture.v2"}, OriginPatterns: []string{"localhost"}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		finish := func() {
			if *closeCode != 0 {
				_ = conn.Close(websocket.StatusCode(*closeCode), "synthetic fixture ended")
			}
		}
		stop := context.AfterFunc(ctx, func() { _ = conn.CloseNow() })
		defer stop()
		generation := connections.Add(1)
		log.Printf("synthetic client connected, connection %d", generation)
		if err := send(conn, &pb.LogEntry{Module: *module, LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: "SYNTHETIC fixture only: invented messages, process arguments and TLS fingerprints; no real capture or TLS handshake."}}); err != nil {
			return
		}
		if *format != "text" {
			data := nativeBytes(*format)
			for offset := 0; offset < len(data); offset += *fragment {
				part := data[offset:min(offset+*fragment, len(data))]
				event := &pb.Event{CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_KEYLOG, Content: &pb.Event_Keylog{Keylog: &pb.KeylogEvent{Data: part}}}
				if *format == "pcapng" {
					event = &pb.Event{CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_PCAPNG, Content: &pb.Event_Pcapng{Pcapng: &pb.PcapngEvent{Data: part}}}
				}
				if err := send(conn, &pb.LogEntry{Module: *module, LogType: pb.LogType_LOG_TYPE_EVENT, Payload: &pb.LogEntry_EventPayload{EventPayload: event}}); err != nil {
					return
				}
			}
			finish()
			return
		}
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for sequence := 1; ; sequence++ {
			// Supply all three body forms immediately, then one pair each second.
			if sequence > 3 {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
			request, response := messages(sequence)
			for _, event := range []*pb.TextEvent{request, response} {
				if err := send(conn, &pb.LogEntry{Module: *module, LogType: pb.LogType_LOG_TYPE_EVENT, Payload: &pb.LogEntry_EventPayload{EventPayload: &pb.Event{CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_TEXT, Content: &pb.Event_Text{Text: event}}}}); err != nil {
					return
				}
			}
			if err := send(conn, &pb.LogEntry{Module: *module, LogType: pb.LogType_LOG_TYPE_HEARTBEAT, Payload: &pb.LogEntry_HeartbeatPayload{HeartbeatPayload: &pb.Heartbeat{Count: int64(sequence), Timestamp: time.Now().Unix()}}}); err != nil {
				return
			}
			if *disconnectAfter > 0 && sequence >= *disconnectAfter {
				log.Printf("synthetic disconnect after %d pairs, connection %d", sequence, generation)
				finish()
				return
			}
		}
	})
	go func() {
		<-ctx.Done()
		closeCtx, stop := context.WithTimeout(context.Background(), 3*time.Second)
		defer stop()
		_ = server.Shutdown(closeCtx)
	}()
	log.Printf("SYNTHETIC eCapture protobuf v2 source ws://%s%s (not real capture)", *addr, *path)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func send(conn *websocket.Conn, entry *pb.LogEntry) error {
	data, err := proto.Marshal(entry)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return conn.Write(ctx, websocket.MessageBinary, data)
}

func messages(sequence int) (*pb.TextEvent, *pb.TextEvent) {
	kind := (sequence - 1) % 3
	path, contentType, encoding := "/synthetic/checker.png", "image/png", ""
	var body []byte
	switch kind {
	case 0:
		img := image.NewRGBA(image.Rect(0, 0, 64, 64))
		for y := 0; y < 64; y++ {
			for x := 0; x < 64; x++ {
				shade := color.RGBA{R: 33, G: 106, B: 220, A: 255}
				if (x/8+y/8)%2 == 0 {
					shade = color.RGBA{R: 250, G: 190, B: 30, A: 255}
				}
				img.SetRGBA(x, y, shade)
			}
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			panic(err)
		}
		body = buf.Bytes()
	case 1, 2:
		path, contentType = "/synthetic/data.json", "application/json; charset=utf-8"
		body, _ = json.Marshal(map[string]any{"synthetic": true, "sequence": sequence, "message": "eCaptureQ local fixture — not captured traffic", "emptyArgumentPreserved": true})
		if kind == 1 {
			path, encoding = "/synthetic/compressed.json", "gzip"
			var buf bytes.Buffer
			writer := gzip.NewWriter(&buf)
			_, _ = writer.Write(body)
			if err := writer.Close(); err != nil {
				panic(err)
			}
			body = buf.Bytes()
		}
	}
	request := []byte(fmt.Sprintf("GET %s?sequence=%d HTTP/1.1\r\nHost: synthetic.invalid\r\nUser-Agent: eCaptureQ-synthetic-fixture\r\nX-Synthetic-Fixture: true\r\n\r\n", path, sequence))
	head := fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\nX-Synthetic-Fixture: true\r\n", contentType, len(body))
	if encoding != "" {
		head += "Content-Encoding: " + encoding + "\r\n"
	}
	response := append([]byte(head+"\r\n"), body...)
	makeEvent := func(payload []byte, direction string, eventSequence uint64) *pb.TextEvent {
		e := &pb.TextEvent{Timestamp: time.Now().Unix(), Uuid: "synthetic-fixture-connection", Pid: 4242, Pname: "synthetic-client", Direction: direction, SrcIp: "192.0.2.10", SrcPort: 54321, DstIp: "198.51.100.20", DstPort: 443, Payload: payload, Length: uint32(len(payload)), OriginalLength: uint32(len(payload)), Sequence: eventSequence,
			ProcessArgs: append([]byte("synthetic-client\x00\x00--label\x00two words\x00"), make([]byte, 16)...), ProcessArgsTruncated: false,
			Tls: map[string]string{"version": "TLS 1.3", "cipher_suite": "TLS_AES_128_GCM_SHA256", "cipher_suite_id": "0x1301", "server_name": "synthetic.invalid", "offered_alpn": "h2,http/1.1", "alpn": "http/1.1", "key_exchange_group": "X25519", "signature_algorithm": "rsa_pss_rsae_sha256", "ja3": "synthetic-ja3-not-a-real-fingerprint", "ja3_raw": "synthetic-fixture-only", "ja4": "synthetic-ja4-not-a-real-fingerprint", "client_hello": "initial"},
		}
		if direction == "response" {
			e.SrcIp, e.DstIp = e.DstIp, e.SrcIp
			e.SrcPort, e.DstPort = e.DstPort, e.SrcPort
		}
		header := fmt.Sprintf("[%s] HTTP/1.1 %s %s:%d -> %s:%d host=%q domain_source=%q connection=%q\n", time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z07:00"), direction, e.SrcIp, e.SrcPort, e.DstIp, e.DstPort, "synthetic.invalid", "Host", e.Uuid)
		e.Payload = append([]byte(header), payload...)
		if len(payload) == 0 || payload[len(payload)-1] != '\n' {
			e.Payload = append(e.Payload, '\n')
		}
		e.Payload = append(e.Payload, '\n')
		e.Length = uint32(len(e.Payload))
		return e
	}
	return makeEvent(request, "request", uint64(2*sequence-1)), makeEvent(response, "response", uint64(2*sequence))
}

// A deliberately empty capture containing a section and Ethernet interface.
// Native chunks can split any block boundary; no invented packets or secrets.
func nativeBytes(format string) []byte {
	if format == "keylog" {
		return []byte("CLIENT_RANDOM " + strings.Repeat("01", 32) + " " + strings.Repeat("02", 48) + "\n")
	}
	var b bytes.Buffer
	for _, n := range []uint32{0x0a0d0d0a, 28, 0x1a2b3c4d, 1, 0xffffffff, 0xffffffff, 28, 1, 20, 1, 65535, 20} {
		_ = binary.Write(&b, binary.LittleEndian, n)
	}
	return b.Bytes()
}
