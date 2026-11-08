// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func TestServiceCloseJoinsConnectedAndRetryingSources(t *testing.T) {
	closed := make(chan struct{})
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer close(closed)
		defer conn.Close()
		var frame []byte
		_ = websocket.Message.Receive(conn, &frame)
	}))
	defer server.Close()
	failed := httptest.NewServer(http.NotFoundHandler())
	unreachable := "ws" + strings.TrimPrefix(failed.URL, "http")
	failed.Close()
	opts := DefaultOptions()
	opts.Endpoints = []string{"ws" + strings.TrimPrefix(server.URL, "http"), unreachable}
	opts.ReconnectDelay, opts.MaxReconnectWait = time.Hour, time.Hour
	service, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	service.Start(context.Background())
	awaitStore(t, service.Store(), func(status Status) bool { return status.State == "degraded" && status.Sources[1].Retries > 0 })
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() { defer wg.Done(); service.Close() }()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not cancel receive/reconnect tasks")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("WebSocket still open")
	}
	service.Start(context.Background())
	if _, err := service.Store().AddSource(SourceConfig{Endpoint: "ws://localhost:9999"}); err == nil {
		t.Fatal("closed service accepted new source")
	}
}

func TestCloseBeforeStartPreventsConnections(t *testing.T) {
	service, err := New(DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	service.Close()
	service.Start(context.Background())
	if service.Store().ctx != nil {
		t.Fatal("closed service started")
	}
}

func TestEvictedRequestIsNotResurrectedByLateResponse(t *testing.T) {
	for _, protocol := range []string{"HTTP/1.1", "HTTP/2", "HTTP/3"} {
		t.Run(protocol, func(t *testing.T) {
			opts := liveTestOptions("ws://localhost:28258/")
			opts.MaxRecords = 1
			store, err := NewStore(opts)
			if err != nil {
				t.Fatal(err)
			}
			mapper := newMapper()
			feed := func(payload, stream string) {
				e := testEvent(payload)
				e.GetEventPayload().StreamId = stream
				store.consume(0, 1, e, mapper, time.Now())
			}
			feed("GET /evicted "+protocol+"\r\nHost: test.example\r\n\r\n", "1")
			feed("GET /next "+protocol+"\r\nHost: test.example\r\n\r\n", "3")
			feed(protocol+" 200 OK\r\nContent-Length: 4\r\n\r\nlate", "1")
			rows := store.Workspace()["requests"].([]json.RawMessage)
			var row Record
			if len(rows) != 1 || json.Unmarshal(rows[0], &row) != nil {
				t.Fatal("missing late response")
			}
			if row["hasRequest"] != false || row["hasResponse"] != true || strings.Contains(string(rows[0]), "/evicted") {
				t.Fatal("evicted request resurrected")
			}
		})
	}
}
