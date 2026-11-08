// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package platform

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gojue/ecaptureq/internal/httpapi"
)

type fakeNative struct {
	calls int
	saved bool
	err   error
	value string
}

func (n *fakeNative) SaveFile(filename, content string) (bool, error) {
	n.calls++
	n.value = filename + ":" + content
	return n.saved, n.err
}
func (n *fakeNative) CopyText(text string) error { n.calls++; n.value = text; return n.err }
func (n *fakeNative) OpenURL(url string) error   { n.calls++; n.value = url; return n.err }

func request(path, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "wails://localhost"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Ecapture-UI", "1")
	r.Header.Set("Origin", "wails://localhost")
	return r
}

func TestNativeActionsAndCancellation(t *testing.T) {
	for _, test := range []struct {
		path, body, expected string
		saved                bool
	}{
		{"/api/platform/export", `{"filename":"capture.json","content":"[]"}`, `"saved":true`, true},
		{"/api/platform/export", `{"filename":"capture.json","content":"[]"}`, `"cancelled":true`, false},
		{"/api/platform/clipboard", `{"text":"observed data"}`, `"ok":true`, false},
		{"/api/platform/open-url", `{"url":"https://example.com/path?q=1"}`, `"ok":true`, false},
	} {
		t.Run(test.path+test.expected, func(t *testing.T) {
			native := &fakeNative{saved: test.saved}
			h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, request(test.path, test.body))
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), test.expected) || native.calls != 1 {
				t.Fatalf("status=%d body=%s calls=%d", w.Code, w.Body, native.calls)
			}
		})
	}
}

func TestNativeRejectsUntrustedWrites(t *testing.T) {
	for _, test := range []struct {
		name, path, body string
		mutate           func(*http.Request)
		status           int
	}{
		{"foreign origin", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, 403},
		{"null origin", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Origin", "null") }, 403},
		{"wrong wails host", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Origin", "wails://evil") }, 403},
		{"missing header", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Del("X-Ecapture-UI") }, 403},
		{"cross site", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		{"wrong type", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{"method", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Method = "GET" }, 405},
		{"filename traversal", "/api/platform/export", `{"filename":"../capture.json","content":"[]"}`, nil, 400},
		{"filename windows", "/api/platform/export", `{"filename":"C:\\capture.json","content":"[]"}`, nil, 400},
		{"unknown field", "/api/platform/export", `{"filename":"capture.json","content":"[]","path":"/tmp/x"}`, nil, 400},
		{"multiple values", "/api/platform/clipboard", `{"text":"x"} {"text":"y"}`, nil, 400},
		{"file url", "/api/platform/open-url", `{"url":"file:///etc/passwd"}`, nil, 400},
		{"javascript url", "/api/platform/open-url", `{"url":"javascript:alert(1)"}`, nil, 400},
		{"credential url", "/api/platform/open-url", `{"url":"https://user:pass@example.com/"}`, nil, 400},
		{"missing host", "/api/platform/open-url", `{"url":"https:///path"}`, nil, 400},
		{"unknown route", "/api/platform/run", `{"command":"echo test"}`, nil, 404},
	} {
		t.Run(test.name, func(t *testing.T) {
			native := &fakeNative{}
			h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}})
			r := request(test.path, test.body)
			if test.mutate != nil {
				test.mutate(r)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != test.status || native.calls != 0 {
				t.Fatalf("status=%d want=%d body=%s calls=%d", w.Code, test.status, w.Body, native.calls)
			}
		})
	}
}

func TestNativeErrorIsVisibleWithoutLeakingPaths(t *testing.T) {
	native := &fakeNative{err: errors.New("permission denied: /private/user-secret")}
	h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request("/api/platform/export", `{"filename":"capture.json","content":"[]"}`))
	if w.Code != 500 || !strings.Contains(w.Body.String(), "export_failed") || strings.Contains(w.Body.String(), "user-secret") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
}

func TestPlatformMountedSubpath(t *testing.T) {
	native := &fakeNative{}
	h, err := httpapi.Mount("/ecaptureq-web/", Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}}))
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request("/ecaptureq-web/api/platform/clipboard", `{"text":"x"}`))
	if w.Code != 200 || native.value != "x" {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, "wails://localhost/ecaptureq-web/api/platform", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || (method == "HEAD" && w.Body.Len() != 0) {
			t.Fatalf("method=%s status=%d body=%s", method, w.Code, w.Body)
		}
	}
}
