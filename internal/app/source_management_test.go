// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	ws "github.com/coder/websocket"
)

func TestSourceManagementPreservesFilesAndOtherConnectors(t *testing.T) {
	server := v2Server(t, func(c *ws.Conn) {
		writeV2(t, c, nativeEntry("keylog", syntheticKeylog()))
		_, _, _ = c.Read(context.Background())
	})
	defer server.Close()
	other := v2Server(t, func(c *ws.Conn) {
		writeV2(t, c, nativeEntry("keylog", syntheticKeylog()))
		_, _, _ = c.Read(context.Background())
	})
	defer other.Close()
	s, _ := startV2Store(t, server)
	endpoint := "ws" + strings.TrimPrefix(other.URL, "http") + "/custom-subscription"
	second, err := s.AddSource(SourceConfig{Endpoint: endpoint})
	if err != nil {
		t.Fatal(err)
	}
	awaitStore(t, s, func(st Status) bool { return len(st.Artifacts) == 2 && st.Sources[1].Events > 0 })
	first := s.Status().Sources[0]
	if _, err = s.ManageSource(first.ID, "edit", SourceConfig{Endpoint: first.Endpoint, Label: "Renamed"}); err != nil {
		t.Fatal(err)
	}
	if st := s.Status(); st.Sources[0].Generation != first.Generation || len(st.Artifacts) != 2 {
		t.Fatal("rename interrupted capture")
	}
	if _, err = s.ManageSource(first.ID, "reconnect", SourceConfig{}); err != nil {
		t.Fatal(err)
	}
	awaitStore(t, s, func(st Status) bool { return len(st.Artifacts) == 3 && st.Sources[0].Generation > first.Generation })
	for _, file := range s.Artifacts() {
		if file.SourceID == first.ID && file.Generation == first.Generation {
			if file.State != "partial" {
				t.Fatal("interrupted file was marked complete")
			}
			r, e := s.OpenArtifact(file.Session, file.ID)
			if e != nil {
				t.Fatal(e)
			}
			data, e := io.ReadAll(r)
			_ = r.Close()
			if e != nil || string(data) != string(syntheticKeylog()) {
				t.Fatal("old file changed")
			}
		}
	}
	if st := s.Status(); st.Sources[1].Generation != 1 {
		t.Fatal("another source reconnected")
	}
	if _, err = s.ManageSource(first.ID, "edit", SourceConfig{Endpoint: endpoint}); err == nil || err.Error() != "duplicate_source" {
		t.Fatal(err)
	}
	if _, err = s.ManageSource(first.ID, "remove", SourceConfig{}); err != nil {
		t.Fatal(err)
	}
	if st := s.Status(); len(st.Sources) != 1 || st.Sources[0].ID != second.ID || len(st.Artifacts) != 3 {
		t.Fatal("remove lost another source or files")
	}
	// The vacated slot is reused, but source identity never is.
	added, err := s.AddSource(SourceConfig{Endpoint: first.Endpoint})
	if err != nil {
		t.Fatal(err)
	}
	if added.ID == first.ID || len(s.sources) != 2 {
		t.Fatal("slot reuse reused an identity or leaked slots")
	}
	awaitStore(t, s, func(st Status) bool { return len(st.Artifacts) == 4 })
	if _, err = s.ManageSource(added.ID, "edit", SourceConfig{Endpoint: first.Endpoint + "?bad=1"}); err == nil {
		t.Fatal("invalid edit accepted")
	}
	if _, err = s.ManageSource(second.ID, "remove", SourceConfig{}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ManageSource(added.ID, "edit", SourceConfig{Endpoint: endpoint, Label: "Moved"}); err != nil {
		t.Fatal(err)
	}
	awaitStore(t, s, func(st Status) bool {
		return len(st.Sources) == 1 && st.Sources[0].Endpoint == endpoint && st.Sources[0].Generation == 2 && len(st.Artifacts) == 5
	})
}

func TestSourceManagementPersistsAtomically(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sources.json")
	initial := `{"headerCenter":"kept","hiddenDomains":["example.test"],"sources":[{"endpoint":"ws://localhost:9001/","label":"first"}]}`
	if err := os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	o := DefaultOptions()
	if err := LoadSources(path, &o); err != nil {
		t.Fatal(err)
	}
	s, err := NewStore(o)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Wait()
	if !s.Status().Sources[0].Persistent {
		t.Fatal("file source persistence not reported")
	}
	id := s.Status().Sources[0].ID
	if _, err = s.ManageSource(id, "edit", SourceConfig{Endpoint: "ws://localhost:9002/", Label: "edited"}); err != nil {
		t.Fatal(err)
	}
	read := func() Config {
		t.Helper()
		data, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		var c Config
		if e = json.Unmarshal(data, &c); e != nil {
			t.Fatal(e)
		}
		return c
	}
	if c := read(); len(c.Sources) != 1 || c.Sources[0].Label != "edited" || c.HeaderCenter != "kept" || c.HiddenDomains[0] != "example.test" {
		t.Fatal(c)
	}
	if _, err = s.ManageSource(id, "remove", SourceConfig{}); err != nil {
		t.Fatal(err)
	}
	if len(read().Sources) != 0 {
		t.Fatal("removed source persisted")
	}
	added, err := s.AddSource(SourceConfig{Endpoint: "ws://localhost:9003/"})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"edit", "remove"} {
		if _, err = s.ManageSource(added.ID, action, SourceConfig{Endpoint: "ws://localhost:9004/"}); err == nil || err.Error() != "source_config_changed" {
			t.Fatal(err)
		}
		if st := s.Status(); len(st.Sources) != 1 || st.Sources[0].Endpoint != "ws://localhost:9003/" {
			t.Fatal("failed persistence mutated live source")
		}
	}
	if read().Sources[0].Label != "first" {
		t.Fatal("external edit overwritten")
	}
}

func TestConcurrentSourceManagementAndShutdown(t *testing.T) {
	s, err := NewStore(DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			source, e := s.AddSource(SourceConfig{Endpoint: fmt.Sprintf("ws://127.0.0.1:%d/", 29000+i)})
			if e != nil {
				return
			}
			_, _ = s.ManageSource(source.ID, "edit", SourceConfig{Endpoint: source.Endpoint, Label: "new"})
			_, _ = s.ManageSource(source.ID, "reconnect", SourceConfig{})
			_, _ = s.ManageSource(source.ID, "remove", SourceConfig{})
		})
	}
	cancel()
	s.Wait()
	wg.Wait()
	if _, err = s.ManageSource("source-1", "remove", SourceConfig{}); err == nil || err.Error() != "service_stopping" {
		t.Fatal(err)
	}
}

func TestCommandLineSourceEditsStaySessionLocal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sources.json")
	initial := `{"sources":[]}`
	if err := os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	o := DefaultOptions()
	o.Endpoints = []string{"ws://localhost:9001/"}
	if err := LoadSources(path, &o); err != nil {
		t.Fatal(err)
	}
	s, err := NewStore(o)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Wait()
	source := s.Status().Sources[0]
	if source.Persistent {
		t.Fatal("command line source incorrectly marked persistent")
	}
	if _, err = s.ManageSource(source.ID, "edit", SourceConfig{Endpoint: "ws://localhost:9002/"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ManageSource(source.ID, "remove", SourceConfig{}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != initial {
		t.Fatal("command line changes modified config")
	}
}
