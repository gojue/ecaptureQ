// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gojue/ecaptureq/frontend"
	"github.com/gojue/ecaptureq/internal/app"
)

func TestClearRecordsAPI(t *testing.T) {
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
			request := func(method, origin, header, site string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "http://localhost"+prefix+"api/records/clear", nil)
				r.Header.Set("Origin", origin)
				r.Header.Set("X-Ecapture-UI", header)
				r.Header.Set("Sec-Fetch-Site", site)
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w
			}
			for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodDelete, http.MethodPut} {
				w := request(method, "http://localhost", "1", "same-origin")
				if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "POST" {
					t.Fatalf("%s permitted clear: %d %s", method, w.Code, w.Body.String())
				}
				if method == http.MethodHead && w.Body.Len() != 0 {
					t.Fatal("HEAD wrote a response body")
				}
			}
			for _, tc := range []struct{ origin, header, site string }{
				{"http://localhost", "", "same-origin"},
				{"http://localhost", "0", "same-origin"},
				{"https://attacker.test", "1", ""},
				{"null", "1", ""},
				{"wails://elsewhere", "1", ""},
				{"http://localhost", "1", "cross-site"},
			} {
				if w := request(http.MethodPost, tc.origin, tc.header, tc.site); w.Code != http.StatusForbidden {
					t.Fatalf("unsafe clear accepted: %+v, %d %s", tc, w.Code, w.Body.String())
				}
			}
			if store.Status().Revision != 0 || store.Status().RecordsRevision != 0 {
				t.Fatal("rejected request mutated store")
			}
			for _, origin := range []string{"http://localhost", "wails://localhost"} {
				before := store.Status()
				w := request(http.MethodPost, origin, "1", "same-origin")
				var response struct {
					Status app.Status `json:"status"`
				}
				if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Status.RecordsRevision != before.RecordsRevision+1 || response.Status.Retained != 0 {
					t.Fatalf("clear failed: %d %s", w.Code, w.Body.String())
				}
				if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Access-Control-Allow-Origin") != "" {
					t.Fatal("clear response enabled caching or CORS")
				}
			}
			store.Wait()
			if w := request(http.MethodPost, "http://localhost", "1", "same-origin"); w.Code != http.StatusServiceUnavailable {
				t.Fatalf("closed store accepted clear: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
