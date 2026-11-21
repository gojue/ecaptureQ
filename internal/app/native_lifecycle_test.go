// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	ws "github.com/coder/websocket"
)

func TestNativeCancellationKeepsPartialUntilSessionCleanup(t *testing.T) {
	server := v2Server(t, func(c *ws.Conn) {
		writeV2(t, c, nativeEntry("keylog", syntheticKeylog()))
		_, _, _ = c.Read(context.Background())
	})
	defer server.Close()
	s, cancel := startV2Store(t, server)
	awaitStore(t, s, func(st Status) bool {
		return len(st.Artifacts) == 1 && st.Artifacts[0].Bytes == int64(len(syntheticKeylog()))
	})
	cancel()
	awaitStore(t, s, func(st Status) bool { return st.State == "stopped" })
	info := s.Artifacts()[0]
	if info.State != "partial" || !strings.HasSuffix(info.Filename, ".partial") || info.Error == "" {
		t.Fatal(info)
	}
	r, err := s.OpenArtifact(info.Session, info.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	got, _ := io.ReadAll(r)
	if !bytes.Equal(got, syntheticKeylog()) {
		t.Fatal("cancellation changed retained bytes")
	}
}

func TestNativeSourcesAndReconnectGenerationsNeverAppend(t *testing.T) {
	payload := func(source int, generation int64) []byte {
		return []byte(fmt.Sprintf("CLIENT_RANDOM %s %s\n", strings.Repeat(fmt.Sprintf("%02x", source+1), 32), strings.Repeat(fmt.Sprintf("%02x", generation), 48)))
	}
	options := DefaultOptions()
	options.Mode = "live"
	options.Native.Dir = t.TempDir()
	options.ReconnectDelay, options.MaxReconnectWait = 10*time.Millisecond, 10*time.Millisecond
	for source := range 2 {
		var generation atomic.Int64
		server := v2Server(t, func(c *ws.Conn) {
			current := generation.Add(1)
			data := payload(source, current)
			writeV2(t, c, nativeEntry("keylog", data[:13]))
			writeV2(t, c, nativeEntry("keylog", data[13:]))
			if current == 1 {
				_ = c.Close(ws.StatusNormalClosure, "synthetic reload boundary")
				return
			}
			_, _, _ = c.Read(context.Background())
		})
		defer server.Close()
		options.Endpoints = append(options.Endpoints, "ws"+strings.TrimPrefix(server.URL, "http")+"/custom-subscription")
	}
	s, err := NewStore(options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	defer stopStore(t, s, cancel)
	awaitStore(t, s, func(st Status) bool {
		if len(st.Artifacts) != 4 || st.Sources[0].Generation != 2 || st.Sources[1].Generation != 2 {
			return false
		}
		for _, info := range st.Artifacts {
			if info.Bytes != int64(len(payload(0, 1))) {
				return false
			}
		}
		return true
	})
	seen := make(map[string]bool)
	for _, info := range s.Artifacts() {
		key := fmt.Sprintf("%s/%d", info.SourceID, info.Generation)
		if seen[key] {
			t.Fatal("duplicate generation artifact", key)
		}
		seen[key] = true
		wantState := "receiving"
		if info.Generation == 1 {
			wantState = "complete"
		}
		if info.State != wantState {
			t.Fatal(info)
		}
		source := 0
		if info.SourceID == "source-2" {
			source = 1
		}
		r, err := s.OpenArtifact(info.Session, info.ID)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(r)
		_ = r.Close()
		if err != nil || !bytes.Equal(got, payload(source, int64(info.Generation))) {
			t.Fatalf("cross-source/generation bytes for %s", key)
		}
	}
	cancel()
	awaitStore(t, s, func(st Status) bool { return st.State == "stopped" })
	for _, info := range s.Artifacts() {
		if info.Generation == 2 && info.State != "partial" {
			t.Fatal(info)
		}
	}
}

type blockedNativeFile struct {
	syncedWriter
	entered, release chan struct{}
}

func (f blockedNativeFile) Write(data []byte) (int, error) {
	close(f.entered)
	<-f.release
	return f.syncedWriter.Write(data)
}

func TestNativeDiskWriteDoesNotHoldStatusLock(t *testing.T) {
	s, err := NewStore(DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Wait()
	a, err := s.artifacts.Begin(s.Status().Session, "source", "", "tls", "keylog", 1)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	a.file = blockedNativeFile{syncedWriter: a.file, entered: entered, release: release}
	done := make(chan struct{})
	go func() { _, _ = a.Write(syntheticKeylog()); close(done) }()
	<-entered
	statusDone := make(chan struct{})
	go func() { _ = s.Status(); close(statusDone) }()
	responsive := false
	select {
	case <-statusDone:
		responsive = true
	case <-time.After(time.Second):
	}
	close(release)
	<-done
	if !responsive {
		t.Fatal("status blocked behind native disk write")
	}
	_ = a.Finish(false, "test stopped")
}
