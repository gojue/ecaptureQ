// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/gojue/ecaptureq/frontend"
	"github.com/gojue/ecaptureq/internal/app"
)

func TestChangesAPI(t *testing.T) {
	for _, prefix := range []string{"/", "/ecaptureq-web/"} {
		t.Run(prefix, func(t *testing.T) {
			opts := app.DefaultOptions()
			store, err := app.NewStore(opts)
			if err != nil {
				t.Fatal(err)
			}
			handler, err := New(opts, store, frontend.Files, Policy{AdditionalOrigins: []string{"wails://localhost"}})
			if err != nil {
				t.Fatal(err)
			}
			handler, err = Mount(prefix, handler)
			if err != nil {
				t.Fatal(err)
			}
			request := func(method, query, origin string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "http://localhost"+prefix+"api/changes"+query, nil)
				r.Header.Set("Origin", origin)
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w
			}
			for _, origin := range []string{"", "http://localhost", "wails://localhost"} {
				w := request("GET", "", origin)
				var status app.Status
				if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &status) != nil || status.Session == "" || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("initial cursor: %d %s", w.Code, w.Body)
				}
			}
			for _, query := range []string{"?revision=-1", "?revision=invalid", "?revision=18446744073709551616"} {
				if w := request("GET", query, ""); w.Code != 400 {
					t.Fatal(w.Code)
				}
			}
			if w := request("GET", "", "https://foreign.test"); w.Code != 403 {
				t.Fatal(w.Code)
			}
			if w := request("POST", "", ""); w.Code != 405 {
				t.Fatal(w.Code)
			}
			if w := request("HEAD", "", ""); w.Code != 200 || w.Body.Len() != 0 {
				t.Fatal(w.Code)
			}
			cursor := store.Status()
			query := "?session=" + url.QueryEscape(cursor.Session) + "&revision=" + strconv.FormatUint(cursor.Revision, 10)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- request("GET", query, "") }()
			select {
			case <-done:
				t.Fatal("unchanged request returned early")
			case <-time.After(20 * time.Millisecond):
			}
			if _, err := store.AddSource(app.SourceConfig{Endpoint: "ws://127.0.0.1:1/"}); err != nil {
				t.Fatal(err)
			}
			select {
			case w := <-done:
				var status app.Status
				if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &status) != nil || status.Revision <= cursor.Revision || status.RecordsRevision != 0 {
					t.Fatalf("notification: %s", w.Body)
				}
			case <-time.After(time.Second):
				t.Fatal("notification did not wake request")
			}
		})
	}
}

func TestChangesTimeoutLimitAndShutdown(t *testing.T) {
	store, err := app.NewStore(app.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	status := store.Status()
	r := httptest.NewRequest("GET", "/api/changes?session="+url.QueryEscape(status.Session)+"&revision=0", nil)
	slots := make(chan struct{}, 1)
	slots <- struct{}{}
	w := httptest.NewRecorder()
	changes(w, r, store, Policy{}, slots)
	if w.Code != 503 || w.Header().Get("Retry-After") == "" {
		t.Fatalf("limit: %d", w.Code)
	}
	<-slots
	ctx, cancel := context.WithCancel(r.Context())
	done := make(chan struct{})
	go func() { changes(httptest.NewRecorder(), r.WithContext(ctx), store, Policy{}, slots); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancel did not stop wait")
	}
	if len(slots) != 0 {
		t.Fatal("cancel leaked slot")
	}
	w = httptest.NewRecorder()
	started := time.Now()
	changes(w, r, store, Policy{}, slots)
	if w.Code != 204 || w.Body.Len() != 0 || time.Since(started) < 9*time.Second || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("timeout: %d %s", w.Code, w.Body)
	}
	store.Wait()
	w = httptest.NewRecorder()
	changes(w, r, store, Policy{}, slots)
	if w.Code != 503 || len(slots) != 0 {
		t.Fatalf("shutdown: %d", w.Code)
	}
}
