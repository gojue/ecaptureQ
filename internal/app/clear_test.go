// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"testing"
	"time"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v2"
)

func TestClearRecordsRemovesRetentionAndPreservesSources(t *testing.T) {
	opts := liveTestOptions("ws://localhost:28258/")
	opts.Endpoints = append(opts.Endpoints, "ws://localhost:28259/")
	opts.MaxRecords = 2
	opts.Native.Dir = t.TempDir()
	s, err := NewStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.artifacts.Close()
	for i := range opts.Endpoints {
		s.updateSource(i, func(source *SourceStatus) {
			source.State, source.Generation = "connected", 3
		})
		s.consume(i, 3, testEvent("GET /before HTTP/1.1\r\nHost: example.test\r\n\r\n"), newMapper(), time.Now())
	}
	s.consume(0, 3, &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: "synthetic operational log"}}, newMapper(), time.Now())
	artifact, err := s.artifacts.Begin(s.Status().Session, "source-1", "synthetic", "tls", "keylog", 3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := artifact.Write(syntheticKeylog()); err != nil {
		t.Fatal(err)
	}
	before := s.Status()
	if before.Retained != 2 || before.RetainedBytes == 0 {
		t.Fatal("fixture did not retain both sources")
	}
	status, err := s.ClearRecords()
	if err != nil {
		t.Fatal(err)
	}
	if status.Retained != 0 || status.RetainedBytes != 0 || status.RecordsRevision != before.RecordsRevision+1 || status.Revision != before.Revision+1 {
		t.Fatalf("clear did not update retention and revisions: %+v", status)
	}
	expected := before
	expected.Retained, expected.RetainedBytes = 0, 0
	expected.Revision++
	expected.RecordsRevision++
	if !reflect.DeepEqual(status, expected) {
		t.Fatalf("clear changed sources, counters, logs, session or artifacts: got %+v; want %+v", status, expected)
	}
	for _, id := range []string{"source-1-3-1", "source-2-3-1"} {
		if _, ok := s.Record(id); ok {
			t.Fatalf("cleared detail %s is still available", id)
		}
	}
	workspace := s.Workspace()
	if len(workspace["requests"].([]json.RawMessage)) != 0 || len(workspace["processes"].([]processInfo)) != 0 {
		t.Fatal("full workspace still contains cleared records or processes")
	}
	page, err := s.WorkspacePage(url.Values{"page": {"10"}, "bookmarks": {"source-1-3-1"}})
	if err != nil {
		t.Fatal(err)
	}
	paging := page["page"].(map[string]any)
	if len(page["requests"].([]Record)) != 0 || paging["index"] != 0 || paging["total"] != 0 || len(paging["bookmarks"].([]string)) != 0 {
		t.Fatal("paged workspace kept cleared rows, page or bookmarks")
	}
	if _, err := artifact.Write(syntheticKeylog()); err != nil {
		t.Fatalf("clear interrupted native artifact writer: %v", err)
	}
	if err := artifact.Finish(true, ""); err != nil {
		t.Fatal(err)
	}
}

func TestClearRecordsPreservesLateResponseFIFO(t *testing.T) {
	for _, protocol := range []string{"HTTP/1.1", "HTTP/2", "HTTP/3"} {
		t.Run(protocol, func(t *testing.T) {
			s, err := NewStore(liveTestOptions("ws://localhost:28258/"))
			if err != nil {
				t.Fatal(err)
			}
			mapper := newMapper()
			feed := func(payload, stream string) {
				entry := testEvent(payload)
				entry.GetEventPayload().GetText().StreamId = stream
				s.consume(0, 1, entry, mapper, time.Now())
			}
			feed("GET /cleared "+protocol+"\r\nHost: example.test\r\n\r\n", "1")
			if _, err := s.ClearRecords(); err != nil {
				t.Fatal(err)
			}
			feed("GET /new "+protocol+"\r\nHost: example.test\r\n\r\n", "3")
			feed(protocol+" 103 Early Hints\r\n\r\n", "1")
			feed(protocol+" 200 OK\r\nContent-Length: 4\r\n\r\nLATE", "1")
			feed(protocol+" 200 OK\r\nContent-Length: 3\r\n\r\nNEW", "3")
			if _, ok := s.Record("source-1-1-1"); ok {
				t.Fatal("cleared request was resurrected")
			}
			rows := s.Workspace()["requests"].([]json.RawMessage)
			if len(rows) != 3 {
				t.Fatalf("want new transaction and two response-only records, got %d", len(rows))
			}
			matched := false
			for _, data := range rows {
				var row Record
				if err := json.Unmarshal(data, &row); err != nil {
					t.Fatal(err)
				}
				if row["id"] == "source-1-1-2" {
					matched = row["path"] == "/new" && row["hasRequest"] == true && row["hasResponse"] == true && row["response"].(map[string]any)["body"] == "NEW"
				} else if row["hasRequest"] != false || row["hasResponse"] != true {
					t.Fatal("late response paired with a cleared or new request")
				}
			}
			if !matched {
				t.Fatal("clear shifted HTTP FIFO or broke stream association")
			}
		})
	}
}

func TestClearRecordsNotifiesWaitersAndRejectsClosedStore(t *testing.T) {
	s, err := NewStore(DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	before := s.Status()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := make(chan Status, 1)
	waitError := make(chan error, 1)
	go func() {
		status, err := s.WaitForChange(ctx, before.Session, before.Revision)
		result <- status
		waitError <- err
	}()
	// Even an empty clear must invalidate a stale client's displayed snapshot.
	after, err := s.ClearRecords()
	if err != nil {
		t.Fatal(err)
	}
	status := <-result
	if err := <-waitError; err != nil || status.Revision != after.Revision || status.RecordsRevision != before.RecordsRevision+1 {
		t.Fatalf("clear failed to wake long poll: %+v, %v", status, err)
	}
	s.Wait()
	closed := s.Status()
	if _, err := s.ClearRecords(); !errors.Is(err, ErrStoreClosed) {
		t.Fatalf("closed store accepted clear: %v", err)
	}
	if !reflect.DeepEqual(s.Status(), closed) {
		t.Fatal("rejected clear changed closed store")
	}
}
