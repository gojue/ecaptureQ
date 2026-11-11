// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"encoding/json"
	"testing"
	"time"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v1"
)

func TestIsHiddenHost(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"github.com", true},
		{"api.github.com", true},
		{"api.github.com:443", true},
		{"raw.githubusercontent.com", true},
		{"objects.githubusercontent.com", true},
		{"pipelines.actions.githubusercontent.com", true},
		{"github.com.", true},
		{"GITHUB.COM", true},
		{"sub.domain.github.io", true},
		{"ghcr.io", true},
		{"githubapp.com", true},
		{"github.dev", true},
		{"githubcopilot.com", true},
		{"example.test", false},
		{"github.com.evil.test", false},
		{"notgithub.com", false},
		{"githubusercontent.com.evil.test", false},
		{"", false},
		{"127.0.0.1", false},
		{"::1", false},
		{"[::1]:443", false},
	}
	for _, c := range cases {
		if got := isHiddenHost(c.host, defaultHiddenDomains); got != c.want {
			t.Errorf("isHiddenHost(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}

func TestHiddenDomainExclusionPreservesAssociation(t *testing.T) {
	store, err := NewStore(liveTestOptions("ws://localhost:28258/"))
	if err != nil {
		t.Fatal(err)
	}
	mapper := newMapper()
	feed := func(uuid, payload string) {
		store.consume(0, 1, githubFixtureEvent(uuid, payload), mapper, time.Now())
	}
	feed("gh-conn", "GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: Bearer ghp_testtoken\r\n\r\n")
	feed("ok-conn", "GET /blog HTTP/1.1\r\nHost: example.test\r\n\r\n")
	feed("gh-conn", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
	feed("ok-conn", "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nBLOG")

	rows := store.Workspace()["requests"].([]json.RawMessage)
	if len(rows) != 1 || store.Status().Filtered != 2 {
		t.Fatalf("retained=%d filtered=%d", len(rows), store.Status().Filtered)
	}
	var record Record
	if err := json.Unmarshal(rows[0], &record); err != nil {
		t.Fatal(err)
	}
	if record["host"] != "example.test" || record["path"] != "/blog" || record["hasResponse"] != true {
		t.Fatal("hidden-domain exclusion disturbed non-hidden request/response association")
	}
}

func githubFixtureEvent(uuid, payload string) *pb.LogEntry {
	event := &pb.Event{
		Uuid:           uuid,
		Pid:            42,
		Pname:          "fixture",
		CaptureFormat:  pb.CaptureFormat_CAPTURE_FORMAT_TEXT,
		Payload:        []byte(payload),
		Length:         uint32(len(payload)),
		OriginalLength: uint32(len(payload)),
		Timestamp:      time.Now().Unix(),
	}
	return &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_EVENT, Payload: &pb.LogEntry_EventPayload{EventPayload: event}}
}
