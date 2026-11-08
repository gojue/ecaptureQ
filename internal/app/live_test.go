// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"golang.org/x/net/websocket"
	"google.golang.org/protobuf/proto"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v1"
)

func liveTestOptions(endpoint string) Options {
	opts := DefaultOptions()
	opts.Mode = "live"
	opts.Endpoints = []string{endpoint}
	opts.ReconnectDelay = 10 * time.Millisecond
	opts.MaxReconnectWait = 40 * time.Millisecond
	return opts
}

func TestSelfCaptureExclusionPreservesHTTPAssociation(t *testing.T) {
	for _, protocol := range []string{"HTTP/1.1", "HTTP/2", "HTTP/3"} {
		t.Run(protocol, func(t *testing.T) {
			opts := liveTestOptions("ws://localhost:28258/")
			opts.ExcludeHTTPPathPrefix = "/ecaptureq-web/"
			store, err := NewStore(opts)
			if err != nil {
				t.Fatal(err)
			}
			mapper := newMapper()
			feed := func(payload, stream string) {
				entry := testEvent(payload)
				if protocol != "HTTP/1.1" {
					entry.GetEventPayload().StreamId = stream
				}
				store.consume(0, 1, entry, mapper, time.Now())
			}
			feed("GET /ecaptureq-web/api/workspace "+protocol+"\r\nHost: example.test\r\n\r\n", "1")
			// Use one connection for both requests; HTTP/1 responses must still
			// associate in order after the first request is hidden from storage.
			feed("GET /blog-post "+protocol+"\r\nHost: example.test\r\n\r\n", "3")
			feed(protocol+" 200 OK\r\nContent-Length: 2\r\n\r\nUI", "1")
			feed(protocol+" 200 OK\r\nContent-Length: 4\r\n\r\nBLOG", "3")
			// A response-only UI message must not restart feedback after a reconnect.
			feed(protocol+" 200 OK\r\nX-Ecaptureq-UI: 1\r\nContent-Length: 2\r\n\r\nUI", "5")
			rows := store.Workspace()["requests"].([]json.RawMessage)
			if len(rows) != 1 || store.Status().Filtered != 3 {
				t.Fatalf("retained=%d filtered=%d", len(rows), store.Status().Filtered)
			}
			var record Record
			if err := json.Unmarshal(rows[0], &record); err != nil {
				t.Fatal(err)
			}
			if record["path"] != "/blog-post" || record["hasResponse"] != true || record["response"].(map[string]any)["body"] != "BLOG" {
				t.Fatal("excluded UI traffic disturbed blog request/response association")
			}
		})
	}
}

func TestSelfCaptureExclusionIsOptIn(t *testing.T) {
	store, err := NewStore(liveTestOptions("ws://localhost:28258/"))
	if err != nil {
		t.Fatal(err)
	}
	store.consume(0, 1, testEvent("GET /ecaptureq-web/ HTTP/1.1\r\nHost: example.test\r\n\r\n"), newMapper(), time.Now())
	if store.Status().Retained != 1 || store.Status().Filtered != 0 {
		t.Fatal("capture was filtered without explicit configuration")
	}
}

func TestDynamicSourcesConnectIndependently(t *testing.T) {
	server := func(path string) *httptest.Server {
		return httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
			defer func() { _ = conn.Close() }()
			if sendTestEntry(conn, testEvent("GET "+path+" HTTP/1.1\r\nHost: example.test\r\n\r\n")) != nil {
				return
			}
			var data []byte
			_ = websocket.Message.Receive(conn, &data)
		}))
	}
	one, two := server("/one"), server("/two")
	defer one.Close()
	defer two.Close()
	failed := httptest.NewServer(http.NotFoundHandler())
	unreachable := "ws" + strings.TrimPrefix(failed.URL, "http")
	failed.Close()
	opts := DefaultOptions()
	opts.Mode = "live"
	opts.ReconnectDelay = 10 * time.Millisecond
	opts.MaxReconnectWait = 40 * time.Millisecond
	store, err := NewStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	store.Start(ctx)
	defer stopStore(t, store, cancel)
	for _, endpoint := range []string{"ws" + strings.TrimPrefix(one.URL, "http"), unreachable, "ws" + strings.TrimPrefix(two.URL, "http")} {
		if _, err := store.AddSource(SourceConfig{Endpoint: endpoint}); err != nil {
			t.Fatal(err)
		}
	}
	awaitStore(t, store, func(s Status) bool { return s.Events == 2 && s.State == "degraded" && s.Sources[1].Retries > 0 })
	status := store.Status()
	if status.Sources[0].State != "connected" || status.Sources[2].State != "connected" || status.Sources[1].State != "reconnecting" {
		t.Fatalf("source states not independent: %+v", status.Sources)
	}
	rows := store.Workspace()["requests"].([]json.RawMessage)
	if len(rows) != 2 {
		t.Fatal("sources lost or merged records")
	}
	ids := make(map[string]bool)
	for _, row := range rows {
		var r Record
		if err := json.Unmarshal(row, &r); err != nil {
			t.Fatal(err)
		}
		ids[r["sourceId"].(string)] = true
	}
	if !ids["source-1"] || !ids["source-3"] {
		t.Fatal("incorrect source attribution")
	}
}

func TestConcurrentSourceCreationAndShutdown(t *testing.T) {
	store, err := NewStore(DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var created atomic.Int64
	for range 20 {
		wg.Go(func() {
			if _, err := store.AddSource(SourceConfig{Endpoint: "ws://LOCALHOST:80"}); err == nil {
				created.Add(1)
			}
		})
	}
	wg.Wait()
	if created.Load() != 1 {
		t.Fatalf("created %d duplicate sources", created.Load())
	}
	if _, err := store.AddSource(SourceConfig{Endpoint: "ws://localhost/"}); err == nil {
		t.Fatal("default-port alias accepted twice")
	}
	for i := 1; i < 16; i++ {
		if _, err := store.AddSource(SourceConfig{Endpoint: fmt.Sprintf("ws://localhost:%d/", 28000+i)}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.AddSource(SourceConfig{Endpoint: "ws://localhost:29999/"}); err == nil || err.Error() != "source_limit" {
		t.Fatalf("source limit failed: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store.Start(ctx)
	store.Wait()
	if _, err := store.AddSource(SourceConfig{Endpoint: "ws://localhost:29999/"}); err == nil || err.Error() != "service_stopping" {
		t.Fatalf("added during shutdown: %v", err)
	}
}

func sendTestEntry(conn *websocket.Conn, entry *pb.LogEntry) error {
	data, err := proto.Marshal(entry)
	if err != nil {
		return err
	}
	return websocket.Message.Send(conn, data)
}

func testEvent(payload string) *pb.LogEntry {
	return &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_EVENT, Payload: &pb.LogEntry_EventPayload{EventPayload: &pb.Event{Uuid: "fixture-connection", Pid: 42, Pname: "fixture", CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_TEXT, Payload: []byte(payload), Length: uint32(len(payload)), OriginalLength: uint32(len(payload)), Timestamp: time.Now().Unix()}}}
}

func awaitStore(t *testing.T, store *Store, ready func(Status) bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if ready(store.Status()) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("live store did not reach expected state: %+v", store.Status())
}

func stopStore(t *testing.T, store *Store, cancel context.CancelFunc) {
	t.Helper()
	cancel()
	done := make(chan struct{})
	go func() { store.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("connector did not stop after cancellation")
	}
}

func TestLiveWebSocketChannelsAndShutdown(t *testing.T) {
	failures := make(chan error, 1)
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		entries := []*pb.LogEntry{
			{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: "diagnostic-only"}},
			{LogType: pb.LogType_LOG_TYPE_HEARTBEAT, Payload: &pb.LogEntry_HeartbeatPayload{HeartbeatPayload: &pb.Heartbeat{Count: 1, Timestamp: time.Now().Unix()}}},
			testEvent("opaque-event\x00\xff"),
			{LogType: pb.LogType_LOG_TYPE_EVENT},
		}
		for _, entry := range entries {
			if err := sendTestEntry(conn, entry); err != nil {
				failures <- err
				return
			}
		}
		if err := websocket.Message.Send(conn, []byte{0xff}); err != nil {
			failures <- err
			return
		}
		if err := websocket.Message.Send(conn, "not a binary frame"); err != nil {
			failures <- err
			return
		}
		var ignored []byte
		_ = websocket.Message.Receive(conn, &ignored)
	}))
	defer server.Close()
	store, err := NewStore(liveTestOptions("ws" + strings.TrimPrefix(server.URL, "http")))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer stopStore(t, store, cancel)
	store.Start(ctx)
	awaitStore(t, store, func(s Status) bool { return s.Events == 1 && s.Malformed == 3 && s.Retained == 1 })
	status := store.Status()
	if status.State != "connected" || status.Sources[0].LastHeartbeat == "" || len(status.Logs) != 1 || status.Logs[0].Message != "diagnostic-only" {
		t.Fatalf("channels were not classified: %+v", status)
	}
	workspace := store.Workspace()
	rows, err := json.Marshal(workspace["requests"])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rows), "diagnostic-only") || strings.Contains(string(rows), "not a binary frame") {
		t.Fatal("operational or malformed messages became captured records")
	}
	processes := workspace["processes"].([]processInfo)
	if len(processes) != 1 || processes[0].Name != "fixture" || fmt.Sprint(processes[0].PID) != "42" {
		t.Fatalf("process identity not preserved: %+v", processes)
	}
	select {
	case err := <-failures:
		t.Fatal(err)
	default:
	}
}

func TestReconnectKeepsRecordsAndChangesGeneration(t *testing.T) {
	var connections atomic.Int64
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		attempt := connections.Add(1)
		if err := sendTestEntry(conn, testEvent(fmt.Sprintf("event generation %d", attempt))); err != nil {
			return
		}
		if attempt == 1 {
			return
		}
		var ignored []byte
		_ = websocket.Message.Receive(conn, &ignored)
	}))
	defer server.Close()
	store, err := NewStore(liveTestOptions("ws" + strings.TrimPrefix(server.URL, "http")))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer stopStore(t, store, cancel)
	store.Start(ctx)
	awaitStore(t, store, func(s Status) bool { return s.Retained == 2 && s.Sources[0].Generation == 2 })
	if status := store.Status(); status.Sources[0].Reconnects != 1 {
		t.Fatalf("reconnection was not recorded: %+v", status)
	}
	rows := store.Workspace()["requests"].([]json.RawMessage)
	var first, second map[string]any
	if err := json.Unmarshal(rows[0], &first); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(rows[1], &second); err != nil {
		t.Fatal(err)
	}
	if first["id"] == second["id"] || first["captureGeneration"] == second["captureGeneration"] {
		t.Fatal("records from different connection generations collided")
	}
}

func TestOversizedWebSocketFrameIsRejected(t *testing.T) {
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		_ = websocket.Message.Send(conn, make([]byte, 4096))
		var ignored []byte
		_ = websocket.Message.Receive(conn, &ignored)
	}))
	defer server.Close()
	options := liveTestOptions("ws" + strings.TrimPrefix(server.URL, "http"))
	options.MaxFrameBytes = 1024
	options.ReconnectDelay, options.MaxReconnectWait = time.Minute, time.Minute
	store, err := NewStore(options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer stopStore(t, store, cancel)
	store.Start(ctx)
	awaitStore(t, store, func(s Status) bool { return s.Sources[0].LastError == "frame_too_large" })
	if status := store.Status(); status.Retained != 0 || status.Malformed != 1 {
		t.Fatalf("oversized frame was not rejected: %+v", status)
	}
}

func TestRetentionAndSnapshotsAreBounded(t *testing.T) {
	options := DefaultOptions()
	options.MaxRecords = 3
	options.MaxBytes = 1024
	store, err := NewStore(options)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for worker := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 20 {
				id := fmt.Sprintf("%d-%d", worker, i)
				store.upsert(Record{"id": id, "processId": id, "payload": strings.Repeat("x", 100)}, &pb.Event{}, "source-1")
				if _, err := json.Marshal(store.Workspace()); err != nil {
					t.Errorf("snapshot encoding: %v", err)
				}
			}
		}()
	}
	wg.Wait()
	status := store.Status()
	if status.Retained > options.MaxRecords || status.RetainedBytes > options.MaxBytes || status.Evicted == 0 {
		t.Fatalf("retention not bounded: %+v", status)
	}
	if len(store.Workspace()["processes"].([]processInfo)) > options.MaxRecords {
		t.Fatal("evicted processes are still retained")
	}
	store.upsert(Record{"id": "too-big", "processId": "unknown", "payload": strings.Repeat("x", 1024)}, &pb.Event{}, "source-1")
	if store.Status().Dropped != 1 {
		t.Fatal("oversized record was not counted as dropped")
	}
}

func TestOperationalLogsRemainBoundedAndSeparate(t *testing.T) {
	store, err := NewStore(liveTestOptions("ws://127.0.0.1:28257/"))
	if err != nil {
		t.Fatal(err)
	}
	mapper := newMapper()
	for i := range 110 {
		store.consume(0, 1, &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: strings.Repeat("测", 2000)}}, mapper, time.Unix(int64(i), 0))
	}
	status := store.Status()
	if len(status.Logs) != 100 || status.Retained != 0 || !utf8.ValidString(status.Logs[0].Message) || len(status.Logs[0].Message) > 4102 {
		t.Fatalf("operational log bounds failed: logs=%d retained=%d", len(status.Logs), status.Retained)
	}
}

func TestEndpointOptionsRejectInvalidConfiguration(t *testing.T) {
	for _, endpoint := range []string{"http://example.test/", "ws:///missing", "ws://user:secret@example.test/", "ws://example.test/?token=secret", "ws://example.test/#fragment"} {
		options := liveTestOptions(endpoint)
		if _, err := NewStore(options); err == nil {
			t.Errorf("accepted invalid endpoint %q", endpoint)
		}
	}
	options := DefaultOptions()
	options.Mode = "live"
	store, err := NewStore(options)
	if err != nil || store.Status().State != "unconfigured" {
		t.Fatalf("empty live mode must allow manual configuration: %v", err)
	}
}

func TestPagedWorkspaceFiltersEntireRetentionAndFetchesDetail(t *testing.T) {
	opts := DefaultOptions()
	opts.Mode = "live"
	opts.MaxRecords = 450
	store, err := NewStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 451; i++ {
		record := Record{"id": fmt.Sprintf("row-%d", i), "processId": "p1", "processName": "client", "processPid": int64(11), "family": "http", "protocol": "HTTP/1.1", "host": "example.test", "state": "complete", "status": 200, "path": fmt.Sprintf("/item/%d", i), "sizeBytes": 2048, "request": emptyHTTPBody(), "response": map[string]any{"headers": []map[string]string{{"name": "Content-Type", "value": "application/json"}}, "body": strings.Repeat("x", 2048)}}
		if i == 1 {
			record["response"].(map[string]any)["body"] = "DeepBodyToken"
			record["responseProcess"] = processInfo{ID: "peer", PID: 22, Name: "server", Command: `"server" "two words"`}
		}
		store.upsert(record, &pb.Event{Pid: 11, Pname: "client"}, "source-1")
	}
	getPage := func(params url.Values) map[string]any {
		t.Helper()
		result, err := store.WorkspacePage(params)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := getPage(url.Values{})
	rows := first["requests"].([]Record)
	if len(rows) != 200 || rows[0]["id"] != "row-450" || first["page"].(map[string]any)["total"] != 450 {
		t.Fatal("wrong first page or retention")
	}
	if rows[0]["request"] != nil || rows[0]["response"] != nil || rows[0]["detailVersion"] == nil {
		t.Fatal("page must contain versioned summaries only")
	}
	last := getPage(url.Values{"page": {"2"}})["requests"].([]Record)
	if len(last) != 50 || last[49]["id"] != "row-1" {
		t.Fatal("wrong last page")
	}
	for _, query := range []url.Values{{"q": {"deepbodytoken"}}, {"process": {"peer"}}, {"scope": {"starred"}, "bookmarks": {"row-0,row-1"}}} {
		page := getPage(query)
		matches := page["requests"].([]Record)
		if len(matches) != 1 || matches[0]["id"] != "row-1" {
			t.Fatal("filter did not search all retained records")
		}
	}
	jsonPage := getPage(url.Values{"filter": {"json"}, "page": {"500"}})
	if jsonPage["page"].(map[string]any)["index"] != 2 {
		t.Fatal("page not clamped after filtering")
	}
	empty := getPage(url.Values{"q": {"never present"}})
	if len(empty["requests"].([]Record)) != 0 || empty["page"].(map[string]any)["index"] != 0 {
		t.Fatal("empty search failed")
	}
	if _, ok := store.Record("row-0"); ok {
		t.Fatal("evicted record still available")
	}
	detail, ok := store.Record("row-1")
	if !ok || !strings.Contains(string(detail), "DeepBodyToken") {
		t.Fatal("full detail unavailable")
	}
	for _, query := range []url.Values{{"page": {"-1"}}, {"page": {"bad"}}, {"q": {strings.Repeat("x", 513)}}} {
		if _, err := store.WorkspacePage(query); err == nil {
			t.Fatal("invalid query accepted")
		}
	}
}

func TestRecordDetailVersionChangesAfterServiceRestart(t *testing.T) {
	first, err := NewStore(DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewStore(DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	second.started = first.started.Add(time.Second)
	row := Record{"id": "source-1-1-1", "processId": "client", "processPid": int64(1)}
	for _, store := range []*Store{first, second} {
		store.upsert(row, &pb.Event{Pid: 1}, "source-1")
	}
	if first.records["source-1-1-1"].Summary["detailVersion"] == second.records["source-1-1-1"].Summary["detailVersion"] {
		t.Fatal("browser could reuse a different session's cached detail")
	}
}
