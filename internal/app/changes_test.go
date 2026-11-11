// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v1"
)

func TestChangeVersions(t *testing.T) {
	opts := liveTestOptions("ws://127.0.0.1:1/")
	opts.MaxRecords = 1
	s, err := NewStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	before := s.Status()
	s.consume(0, 1, &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_PROCESS_LOG, Payload: &pb.LogEntry_RunLog{RunLog: "synthetic log"}}, newMapper(), time.Now())
	after := s.Status()
	if after.Revision <= before.Revision || after.RecordsRevision != before.RecordsRevision {
		t.Fatal("status-only changes must not invalidate records")
	}
	for i, id := range []string{"one", "one", "two"} {
		s.upsert(Record{"id": id, "processId": "process", "family": "raw"}, &pb.Event{}, "source-1")
		status := s.Status()
		if status.RecordsRevision != uint64(i+1) {
			t.Fatalf("insert/update/eviction version: %+v", status)
		}
	}
	if s.Status().Evicted != 1 {
		t.Fatal("fixture did not evict")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	// A change between the snapshot and subscription must return immediately.
	if status, err := s.WaitForChange(ctx, before.Session, before.Revision); err != nil || status.RecordsRevision != 3 {
		t.Fatalf("missed prior change: %+v, %v", status, err)
	}
	current := s.Status()
	if _, err := s.WaitForChange(ctx, "previous-session", current.Revision); err != nil {
		t.Fatal(err)
	}
}

func TestChangeWaitBroadcastAndCleanup(t *testing.T) {
	s, err := NewStore(liveTestOptions("ws://127.0.0.1:1/"))
	if err != nil {
		t.Fatal(err)
	}
	before := s.Status()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			status, err := s.WaitForChange(ctx, before.Session, before.Revision)
			if err != nil || status.Revision <= before.Revision {
				t.Errorf("missed broadcast: %+v, %v", status, err)
			}
		})
	}
	s.updateSource(0, func(source *SourceStatus) { source.State = "connected" })
	wg.Wait()
	current := s.Status()
	timeout, stop := context.WithTimeout(ctx, 20*time.Millisecond)
	defer stop()
	if _, err := s.WaitForChange(timeout, current.Session, current.Revision); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unchanged cursor should wait: %v", err)
	}
	cancelled, stopCancelled := context.WithCancel(ctx)
	stopCancelled()
	if _, err := s.WaitForChange(cancelled, current.Session, current.Revision); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := s.WaitForChange(ctx, current.Session, current.Revision); done <- err }()
	s.Wait()
	if err := <-done; !errors.Is(err, ErrStoreClosed) {
		t.Fatalf("shutdown: %v", err)
	}
}
