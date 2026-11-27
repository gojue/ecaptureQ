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

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v2"
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
					entry.GetEventPayload().GetText().StreamId = stream
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
		return httptest.NewServer(testWSHandler(func(conn *websocket.Conn) {
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
	// Events is updated before mapping and storage; wait for both records too.
	awaitStore(t, store, func(s Status) bool {
		return s.Events == 2 && s.Retained == 2 && s.State == "degraded" && s.Sources[1].Retries > 0
	})
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
	return &pb.LogEntry{Module: "tls", LogType: pb.LogType_LOG_TYPE_EVENT, Payload: &pb.LogEntry_EventPayload{EventPayload: &pb.Event{CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_TEXT, Content: &pb.Event_Text{Text: &pb.TextEvent{Uuid: "fixture-connection", Pid: 42, Pname: "fixture", Payload: []byte(payload), Length: uint32(len(payload)), OriginalLength: uint32(len(payload)), Timestamp: time.Now().Unix()}}}}}
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
	server := httptest.NewServer(testWSHandler(func(conn *websocket.Conn) {
		entries := []*pb.LogEntry{
			{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: "diagnostic-only"}},
			{LogType: pb.LogType_LOG_TYPE_HEARTBEAT, Payload: &pb.LogEntry_HeartbeatPayload{HeartbeatPayload: &pb.Heartbeat{Count: 1, Timestamp: time.Now().Unix()}}},
			testEvent("opaque-event\x00\xff"),
		}
		for _, entry := range entries {
			if err := sendTestEntry(conn, entry); err != nil {
				failures <- err
				return
			}
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
	awaitStore(t, store, func(s Status) bool { return s.Events == 1 && s.Malformed == 0 && s.Retained == 1 })
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
	server := httptest.NewServer(testWSHandler(func(conn *websocket.Conn) {
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

func collectorTestLog(t *testing.T, info *CollectorInfo) *pb.LogEntry {
	t.Helper()
	message, err := json.Marshal(map[string]any{"event": "collector_info", "schemaVersion": 1, "collector": info})
	if err != nil {
		t.Fatal(err)
	}
	return &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: string(message)}}
}

func TestCollectorInfoIsSourceScopedAndNeverOperatorConfigured(t *testing.T) {
	opts := liveTestOptions("ws://localhost:28258/")
	opts.Endpoints = append(opts.Endpoints, "ws://localhost:28259/")
	opts.Sources = []SourceConfig{{Endpoint: opts.Endpoints[0], Capture: &CaptureInfo{Module: "operator-module", Command: "operator-command"}}}
	store, err := NewStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	store.sources[0].Generation = 2
	if store.Status().Sources[0].Collector != nil {
		t.Fatal("operator metadata became received collector metadata")
	}
	info := &CollectorInfo{Host: "capture-host", Module: "gotls", Mode: "text", TextSource: "pcapng", Argv: []string{"ecapture", "gotls", "", "two words", "$(not-executed)"}, Version: "test-version", BuildTime: "2026-11-21T01:02:03Z", DecryptorVersion: "v1.4.4", Outputs: []string{"stdout", "file:///example.jsonl"}}
	store.consume(0, 2, collectorTestLog(t, info), newMapper(), time.Now())
	status := store.Status()
	if status.Sources[0].Collector == nil || status.Sources[0].Collector.Argv[3] != "two words" || status.Sources[1].Collector != nil || len(status.Logs) != 0 || status.Events != 0 || status.Retained != 0 {
		t.Fatalf("collector information was not isolated: %+v", status)
	}
	status.Sources[0].Collector.Argv[0] = "mutated"
	status.Sources[0].Collector.Outputs[0] = "mutated"
	status.Sources[0].Collector.Host = "mutated"
	if got := store.Status().Sources[0].Collector; got.Argv[0] != "ecapture" || got.Outputs[0] != "stdout" || got.Host != "capture-host" {
		t.Fatal("status snapshot changed live collector metadata")
	}
	store.consume(0, 1, collectorTestLog(t, &CollectorInfo{Module: "stale"}), newMapper(), time.Now())
	if store.Status().Sources[0].Collector.Module != "gotls" {
		t.Fatal("stale generation replaced current collector metadata")
	}
	store.consume(0, 2, testEvent("opaque-event"), newMapper(), time.Now())
	if got := store.Workspace()["processes"].([]processInfo)[0].Kind; got != "tls" {
		t.Fatalf("process module %q did not preserve the observed event module", got)
	}
	bad := collectorTestLog(t, info)
	bad.Payload = &pb.LogEntry_RunLog{RunLog: `{"event":"collector_info","schemaVersion":2,"collector":{}}`}
	store.consume(0, 2, bad, newMapper(), time.Now())
	if status := store.Status(); status.Sources[0].Collector != nil || status.Malformed != 1 || len(status.Logs) != 0 {
		t.Fatal("invalid snapshot retained metadata or entered operational logs")
	}
	ordinary := &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: `{"event":"probe_started","message":"ready"}`}}
	store.consume(0, 2, ordinary, newMapper(), time.Now())
	if logs := store.Status().Logs; len(logs) != 1 || logs[0].Message != ordinary.GetRunLog() {
		t.Fatal("ordinary structured log handling changed")
	}
}

func TestCollectorInfoLimits(t *testing.T) {
	for name, message := range map[string]string{
		"missing collector":   `{"event":"collector_info","schemaVersion":1}`,
		"null collector":      `{"event":"collector_info","schemaVersion":1,"collector":null}`,
		"unknown schema":      `{"event":"collector_info","schemaVersion":2,"collector":{}}`,
		"invalid build time":  `{"event":"collector_info","schemaVersion":1,"collector":{"buildTime":"yesterday"}}`,
		"non UTC build time":  `{"event":"collector_info","schemaVersion":1,"collector":{"buildTime":"2026-11-21T01:02:03+08:00"}}`,
		"NUL argument":        `{"event":"collector_info","schemaVersion":1,"collector":{"argv":["bad\u0000argument"]}}`,
		"wrong argument type": `{"event":"collector_info","schemaVersion":1,"collector":{"argv":[123]}}`,
		"invalid UTF8":        "{\"event\":\"collector_info\",\"schemaVersion\":1,\"collector\":{\"host\":\"\xff\"}}",
		"oversized payload":   `{"event":"collector_info","schemaVersion":1,"collector":{},"padding":"` + strings.Repeat("x", 256<<10) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if info, recognized := parseCollectorInfo(message); !recognized || info != nil {
				t.Fatalf("invalid snapshot accepted: recognized=%v info=%+v", recognized, info)
			}
		})
	}
	for name, info := range map[string]*CollectorInfo{
		"oversized host":      {Host: strings.Repeat("x", 257)},
		"oversized module":    {Module: strings.Repeat("x", 65)},
		"oversized version":   {Version: strings.Repeat("x", 513)},
		"oversized listener":  {StreamListen: strings.Repeat("x", 2049)},
		"too many arguments":  {Argv: make([]string, 257)},
		"oversized arguments": {Argv: []string{strings.Repeat("x", 8192), "x"}},
		"too many outputs":    {Outputs: make([]string, 65)},
		"oversized outputs":   {Outputs: []string{strings.Repeat("x", 8193)}},
	} {
		t.Run(name, func(t *testing.T) {
			if got, recognized := parseCollectorInfo(collectorTestLog(t, info).GetRunLog()); !recognized || got != nil {
				t.Fatal("metadata field limit was not enforced")
			}
		})
	}
	info := &CollectorInfo{Argv: []string{strings.Repeat("x", 8192)}, ArgvTruncated: true, OutputsTruncated: true}
	if got, recognized := parseCollectorInfo(collectorTestLog(t, info).GetRunLog()); !recognized || got == nil || len(got.Argv[0]) != 8192 || !got.ArgvTruncated || !got.OutputsTruncated {
		t.Fatal("bounded truncated snapshot was not preserved")
	}
}

func TestReconnectClearsCollectorInfoUntilNewSnapshot(t *testing.T) {
	var connections atomic.Int64
	reconnect := make(chan struct{})
	release := sync.OnceFunc(func() { close(reconnect) })
	info := collectorTestLog(t, &CollectorInfo{Module: "gotls", Version: "old-process"})
	server := httptest.NewServer(testWSHandler(func(conn *websocket.Conn) {
		defer func() { _ = conn.Close() }()
		if connections.Add(1) == 1 {
			if sendTestEntry(conn, info) != nil {
				return
			}
			<-reconnect
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
	defer release()
	store.Start(ctx)
	awaitStore(t, store, func(s Status) bool { return s.Sources[0].Collector != nil })
	release()
	awaitStore(t, store, func(s Status) bool { return s.Sources[0].Generation == 2 && s.State == "connected" })
	if store.Status().Sources[0].Collector != nil {
		t.Fatal("previous collector metadata survived reconnect without a new snapshot")
	}
}

func TestOversizedWebSocketFrameIsRejected(t *testing.T) {
	server := httptest.NewServer(testWSHandler(func(conn *websocket.Conn) {
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
				store.upsert(Record{"id": id, "processId": id, "payload": strings.Repeat("x", 100)}, &pb.TextEvent{}, "source-1")
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
	store.upsert(Record{"id": "too-big", "processId": "unknown", "payload": strings.Repeat("x", 1024)}, &pb.TextEvent{}, "source-1")
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
		store.upsert(record, &pb.TextEvent{Pid: 11, Pname: "client"}, "source-1")
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
		store.upsert(row, &pb.TextEvent{Pid: 1}, "source-1")
	}
	if first.records["source-1-1-1"].Summary["detailVersion"] == second.records["source-1-1-1"].Summary["detailVersion"] {
		t.Fatal("browser could reuse a different session's cached detail")
	}
}

// The test server explicitly negotiates the same protocol as the real collector.
func testWSHandler(handler func(*websocket.Conn)) http.Handler {
	return websocket.Server{Handler: websocket.Handler(handler), Handshake: func(config *websocket.Config, request *http.Request) error {
		if request.Header.Get("Sec-WebSocket-Protocol") != "ecapture.v2" || request.Header.Get("Origin") == "" {
			return fmt.Errorf("v2 handshake required")
		}
		config.Protocol = []string{"ecapture.v2"}
		return nil
	}}
}
