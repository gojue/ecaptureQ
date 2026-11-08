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
	"sync/atomic"
	"syscall"
	"time"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v1"
	"golang.org/x/net/websocket"
	"google.golang.org/protobuf/proto"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:28359", "Synthetic WebSocket source listen address")
	disconnectAfter := flag.Int("disconnect-after", 0, "Disconnect after N completed synthetic request/response pairs (0: continue)")
	flag.Parse()
	if *disconnectAfter < 0 || flag.NArg() != 0 {
		log.Fatal("disconnect-after must be nonnegative; positional arguments are not accepted")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var connections atomic.Uint64
	server := &http.Server{Addr: *addr, ReadHeaderTimeout: 5 * time.Second}
	server.Handler = websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
		defer stop()
		generation := connections.Add(1)
		log.Printf("synthetic client connected, connection %d", generation)
		if err := send(conn, &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: "SYNTHETIC fixture only: invented messages, process arguments and TLS fingerprints; no real capture or TLS handshake."}}); err != nil {
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
			for _, event := range []*pb.Event{request, response} {
				if err := send(conn, &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_EVENT, Payload: &pb.LogEntry_EventPayload{EventPayload: event}}); err != nil {
					return
				}
			}
			if err := send(conn, &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_HEARTBEAT, Payload: &pb.LogEntry_HeartbeatPayload{HeartbeatPayload: &pb.Heartbeat{Count: int64(sequence), Timestamp: time.Now().Unix()}}}); err != nil {
				return
			}
			if *disconnectAfter > 0 && sequence >= *disconnectAfter {
				log.Printf("synthetic disconnect after %d pairs, connection %d", sequence, generation)
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
	log.Printf("SYNTHETIC eCapture protobuf source ws://%s/ (not real capture)", *addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func send(conn *websocket.Conn, entry *pb.LogEntry) error {
	data, err := proto.Marshal(entry)
	if err != nil {
		return err
	}
	if err = conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return websocket.Message.Send(conn, data)
}

func messages(sequence int) (*pb.Event, *pb.Event) {
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
	makeEvent := func(payload []byte, direction string, eventSequence uint64) *pb.Event {
		e := &pb.Event{Timestamp: time.Now().Unix(), Uuid: "synthetic-fixture-connection", Pid: 4242, Pname: "synthetic-client", Direction: direction, SrcIp: "192.0.2.10", SrcPort: 54321, DstIp: "198.51.100.20", DstPort: 443, CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_TEXT, Payload: payload, Length: uint32(len(payload)), OriginalLength: uint32(len(payload)), Sequence: eventSequence,
			ProcessArgs: append([]byte("synthetic-client\x00\x00--label\x00two words\x00"), make([]byte, 16)...), ProcessArgsTruncated: false,
			Tls: map[string]string{"version": "TLS 1.3", "cipher_suite": "TLS_AES_128_GCM_SHA256", "cipher_suite_id": "0x1301", "server_name": "synthetic.invalid", "offered_alpn": "h2,http/1.1", "alpn": "http/1.1", "key_exchange_group": "X25519", "signature_algorithm": "rsa_pss_rsae_sha256", "ja3": "synthetic-ja3-not-a-real-fingerprint", "ja3_raw": "synthetic-fixture-only", "ja4": "synthetic-ja4-not-a-real-fingerprint", "client_hello": "initial"},
		}
		if direction == "response" {
			e.SrcIp, e.DstIp = e.DstIp, e.SrcIp
			e.SrcPort, e.DstPort = e.DstPort, e.SrcPort
		}
		return e
	}
	return makeEvent(request, "request", uint64(2*sequence-1)), makeEvent(response, "response", uint64(2*sequence))
}
