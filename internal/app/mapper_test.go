// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v1"
)

func mapperEvent(data string) *pb.Event {
	return &pb.Event{Timestamp: 1700000000, Uuid: "connection-a", SrcIp: "192.0.2.1", SrcPort: 54321, DstIp: "192.0.2.2", DstPort: 443, Pid: 42, Pname: "demo-client", Direction: "request", CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_TEXT, Payload: []byte(data), Length: uint32(len(data)), OriginalLength: uint32(len(data))}
}
func mapOne(t *testing.T, m *eventMapper, source string, generation uint64, e *pb.Event) Record {
	t.Helper()
	rows := m.Map(source, generation, e, time.Unix(1700000001, 123))
	if len(rows) != 1 {
		t.Fatalf("got %d records", len(rows))
	}
	return rows[0]
}
func structuredEvent(protocol, direction string, metadata map[string]any, data []byte) *pb.Event {
	encoded, _ := json.Marshal(metadata)
	payload := fmt.Sprintf("[2026-11-07T00:00:00.123456789Z] %s %s 192.0.2.1:54321 -> 192.0.2.2:443 connection=\"connection-a\" kind=%v length=%d encoding=hex metadata=%s\n%s\n\n", protocol, direction, metadata["kind"], len(data), encoded, hex.EncodeToString(data))
	e := mapperEvent(payload)
	if direction == "server_to_client" {
		e.Direction = "response"
	}
	return e
}

func TestMapperHTTPAssociationAndIsolation(t *testing.T) {
	for _, protocol := range []string{"HTTP/1.1", "HTTP/2.0", "HTTP/3.0"} {
		t.Run(protocol, func(t *testing.T) {
			m := newMapper()
			request := mapperEvent("GET /first " + protocol + "\r\nHost: demo.test\r\n\r\n")
			request.StreamId = "0"
			first := mapOne(t, m, "source-1", 1, request)
			secondRequest := mapperEvent("POST /second " + protocol + "\r\nHost: demo.test\r\nContent-Length: 2\r\n\r\n{}")
			secondRequest.StreamId = "4"
			second := mapOne(t, m, "source-1", 1, secondRequest)
			response := mapperEvent(protocol + " 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
			response.Direction = "response"
			response.StreamId = "4"
			got := mapOne(t, m, "source-1", 1, response)
			if got["id"] != second["id"] || got["path"] != "/second" || got["state"] != "complete" || got["hasResponse"] != true {
				t.Fatalf("wrong response association: id=%v path=%v state=%v", got["id"], got["path"], got["state"])
			}
			if got["durationMs"] != nil {
				t.Fatal("seconds-only timestamp fabricated millisecond timing")
			}
			response.StreamId = "0"
			isolated := mapOne(t, m, "source-2", 1, response)
			if isolated["id"] == first["id"] || isolated["hasRequest"] != false {
				t.Fatal("cross-source response associated")
			}
			isolated = mapOne(t, m, "source-1", 2, response)
			if isolated["hasRequest"] != false {
				t.Fatal("cross-generation response associated")
			}
			got = mapOne(t, m, "source-1", 1, response)
			if got["id"] != first["id"] || got["host"] != "demo.test" {
				t.Fatal("first request lost")
			}
			if got["localAddress"] != "" || got["sourceAddress"] != "192.0.2.1:54321" {
				t.Fatal("fabricated local/remote orientation")
			}
		})
	}
}

func TestMapperHTTPFIFOAndMissingSide(t *testing.T) {
	m := newMapper()
	a := mapOne(t, m, "s", 1, mapperEvent("GET /a HTTP/1.1\r\nHost: demo.test\r\n\r\n"))
	b := mapOne(t, m, "s", 1, mapperEvent("GET /b HTTP/1.1\r\nHost: demo.test\r\n\r\n"))
	response := mapperEvent("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	response.Direction = "response"
	if got := mapOne(t, m, "s", 1, response); got["id"] != a["id"] {
		t.Fatal("HTTP/1 FIFO first mismatch")
	}
	if got := mapOne(t, m, "s", 1, response); got["id"] != b["id"] {
		t.Fatal("HTTP/1 FIFO second mismatch")
	}
	missing := mapOne(t, m, "s", 1, response)
	if missing["hasRequest"] != false || missing["metadata"].(map[string]any)["association"] != "response-only" {
		t.Fatal("missing request was invented")
	}
	h3 := mapperEvent("GET /h3 HTTP/3.0\r\n\r\n")
	mapOne(t, m, "s", 1, h3)
	h3.Payload = []byte("HTTP/3.0 204\r\n\r\n")
	h3.Direction = "response"
	if got := mapOne(t, m, "s", 1, h3); got["hasRequest"] != false {
		t.Fatal("HTTP/3 without stream ID must not be paired")
	}
}

func TestMapperTLSMetadataFromPairedResponse(t *testing.T) {
	m := newMapper()
	request := structuredEvent("http/1.1", "client_to_server", map[string]any{
		"kind": "message", "tls": map[string]any{"ja3": "client-fingerprint", "server_name": "hello.test"},
	}, []byte("GET / HTTP/1.1\r\nHost: different.test\r\n\r\n"))
	request.Tls = map[string]string{"ja4": "typed-fingerprint"}
	first := mapOne(t, m, "s", 1, request)
	response := structuredEvent("http/1.1", "server_to_client", map[string]any{
		"kind": "message", "tls": map[string]any{"version": "TLS 1.3", "alpn": "h2", "ja3": ""},
	}, []byte("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"))
	got := mapOne(t, m, "s", 1, response)
	tls := got["metadata"].(map[string]any)["tls"].(map[string]any)
	if got["id"] != first["id"] || tls["ja3"] != "client-fingerprint" || tls["alpn"] != "h2" || tls["server_name"] != "hello.test" {
		t.Fatalf("TLS metadata lost during association: %v", tls)
	}
	if first["metadata"].(map[string]any)["tls"].(map[string]any)["alpn"] != nil {
		t.Fatal("request TLS snapshot mutated")
	}
	isolated := mapOne(t, m, "other", 1, response)
	if isolated["metadata"].(map[string]any)["tls"].(map[string]any)["server_name"] != nil {
		t.Fatal("TLS metadata crossed data sources")
	}
	plain := mapOne(t, m, "s", 2, mapperEvent("GET / HTTP/1.1\r\nHost: hello.test\r\n\r\n"))
	if plain["metadata"].(map[string]any)["tls"] != nil {
		t.Fatal("TLS metadata inferred from HTTP content")
	}
	typed := mapperEvent("GET /typed HTTP/1.1\r\nHost: hello.test\r\n\r\n")
	typed.Tls = map[string]string{"ja3": "typed-client", "version": "TLS 1.3"}
	mapped := mapOne(t, m, "typed", 1, typed)
	typed.Tls["ja3"] = "changed"
	if mapped["metadata"].(map[string]any)["tls"].(map[string]any)["ja3"] != "typed-client" {
		t.Fatal("typed TLS metadata lost or aliased")
	}

}

func TestMapperHTTPBinaryChunkingAndPartial(t *testing.T) {
	m := newMapper()
	e := mapperEvent("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n\x00\xffA")
	e.Direction = "response"
	r := mapOne(t, m, "s", 1, e)
	body := r["response"].(map[string]any)
	if body["body"] != "00ff41" || body["bodyEncoding"] != "hex" || body["byteLength"] != 3 {
		t.Fatal("binary HTTP body was not lossless")
	}
	e = mapperEvent("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n")
	e.Direction = "response"
	r = mapOne(t, m, "s", 1, e)
	if r["response"].(map[string]any)["body"] != "abc" {
		t.Fatal("HTTP chunked application body not decoded")
	}
	e = mapperEvent("POST /partial HTTP/1.1\r\nContent-Length: 20\r\n\r\nshort")
	r = mapOne(t, m, "s", 1, e)
	if r["state"] != "partial" {
		t.Fatal("incomplete HTTP body reported complete")
	}
	e = mapperEvent("GET / HTTP/1.1\r\nHost: partial")
	if r = mapOne(t, m, "s", 1, e); r["family"] != "raw" {
		t.Fatal("incomplete header treated as complete message")
	}
}

func TestMapperStructuredQUICPreservesBinaryAndZero(t *testing.T) {
	m := newMapper()
	e := structuredEvent("quic", "client_to_server", map[string]any{"kind": "stream_chunk", "offset": 0, "end": false, "stream_id": 0, "encryption_level": "1rtt"}, []byte{0, 255, 16})
	r := mapOne(t, m, "s", 1, e)
	meta := r["metadata"].(map[string]any)
	if r["family"] != "quic" || r["payload"] != "00ff10" || r["payloadEncoding"] != "hex" || r["sizeBytes"] != 3 {
		t.Fatal("QUIC binary was altered")
	}
	if valueString(meta["offset"]) != "0" || meta["end"] != false || r["streamId"] != "0" {
		t.Fatal("zero/false QUIC metadata lost")
	}
	if r["startedAt"] != "2026-11-07T00:00:00.123456789Z" {
		t.Fatal("structured timestamp precision lost")
	}
	e = structuredEvent("quic", "server_to_client", map[string]any{"kind": "datagram", "encryption_level": "0rtt", "early_data": "rejected"}, nil)
	r = mapOne(t, m, "s", 1, e)
	if r["sizeBytes"] != 0 || r["payload"] != "" || r["operation"] != "DATAGRAM" {
		t.Fatal("empty datagram lost")
	}
	if _, ok := r["streamId"]; ok {
		t.Fatal("datagram has fabricated stream ID")
	}
	if _, ok := r["metadata"].(map[string]any)["version"]; ok {
		t.Fatal("QUIC version was fabricated")
	}
}

func TestMapperMalformedStructuredRetainsRaw(t *testing.T) {
	good := structuredEvent("quic", "client_to_server", map[string]any{"kind": "datagram"}, []byte{1, 2})
	for _, change := range []func([]byte) []byte{
		func(b []byte) []byte { return bytes.Replace(b, []byte("length=2"), []byte("length=3"), 1) },
		func(b []byte) []byte { return bytes.Replace(b, []byte("0102"), []byte("zz02"), 1) },
		func(b []byte) []byte { return bytes.Replace(b, []byte("metadata={"), []byte("metadata=broken{"), 1) },
		func(b []byte) []byte {
			return bytes.Replace(b, []byte("2026-11-07T00:00:00.123456789Z"), []byte("invalid-time"), 1)
		},
	} {
		e := mapperEvent(string(change(good.Payload)))
		r := mapOne(t, newMapper(), "s", 1, e)
		if r["family"] != "raw" || r["payload"] != string(e.Payload) || r["metadata"].(map[string]any)["parseError"] == nil {
			t.Fatal("malformed event lost or misclassified")
		}
	}
}

func TestMapperRedisAssociationPushNullAndBinary(t *testing.T) {
	m := newMapper()
	req := structuredEvent("redis", "client_to_server", map[string]any{"kind": "request", "request_id": 1, "command": "GET", "resp_type": "*"}, []byte("*2\r\n$3\r\nGET\r\n$4\r\nkey1\r\n"))
	request := mapOne(t, m, "s", 1, req)
	if request["state"] != "pending" {
		t.Fatal("Redis request not pending")
	}
	push := structuredEvent("redis", "server_to_client", map[string]any{"kind": "push", "resp_type": ">"}, []byte(">3\r\n+message\r\n+orders\r\n+demo\r\n"))
	pushed := mapOne(t, m, "s", 1, push)
	if pushed["id"] == request["id"] || pushed["metadata"].(map[string]any)["kind"] != "push" {
		t.Fatal("push consumed request")
	}
	resp := structuredEvent("redis", "server_to_client", map[string]any{"kind": "response", "request_id": 1, "command": "GET", "resp_type": "_"}, []byte("_\r\n"))
	got := mapOne(t, m, "s", 1, resp)
	meta := got["metadata"].(map[string]any)
	if got["id"] != request["id"] || meta["matched"] != true || meta["result"].(map[string]any)["type"] != "null" {
		t.Fatal("Redis null response failed association")
	}
	resp = structuredEvent("redis", "server_to_client", map[string]any{"kind": "response", "request_id": 99, "resp_type": "$"}, []byte("$3\r\na\x00b\r\n"))
	got = mapOne(t, m, "s", 1, resp)
	node := got["metadata"].(map[string]any)["result"].(map[string]any)
	if node["value"] != "610062" || node["encoding"] != "hex" {
		t.Fatal("binary RESP bytes lost")
	}
}

func TestRESPValidationAndNestedValues(t *testing.T) {
	parsed, err := parseRESP([]byte("|2\r\n+hits\r\n:9007199254740993\r\n+flags\r\n*2\r\n#f\r\n_\r\n"))
	if err != nil || parsed["type"] != "attribute" {
		t.Fatalf("attribute parse error %v", err)
	}
	values := parsed["value"].([]any)
	integer := values[0].(map[string]any)["value"].(map[string]any)
	if integer["value"] != "9007199254740993" {
		t.Fatal("64-bit RESP integer rounded")
	}
	for _, bad := range []string{"$3\r\nab\r\n", "*2\r\n+one\r\n", "#x\r\n", "$-2\r\n", "+ok\r\ntrailing", strings.Repeat("*1\r\n", maxRESPDepth+2) + "+a\r\n"} {
		if _, err := parseRESP([]byte(bad)); err == nil {
			t.Fatal("malformed RESP accepted")
		}
	}
}

func TestMapperRedisPushKindsDoNotInventChannels(t *testing.T) {
	for _, test := range []struct{ kind, payload, channel, summary string }{
		{"invalidate", ">2\r\n+invalidate\r\n*1\r\n+cache:key\r\n", "", "Push · invalidate"},
		{"message", ">3\r\n+message\r\n+orders\r\n+demo\r\n", "orders", "Push · orders"},
		{"smessage", ">3\r\n+smessage\r\n+shard:orders\r\n+demo\r\n", "shard:orders", "Push · shard:orders"},
		{"pmessage", ">4\r\n+pmessage\r\n+orders:*\r\n+orders:created\r\n+demo\r\n", "orders:created", "Push · orders:created"},
		{"subscribe", ">3\r\n+subscribe\r\n+orders\r\n:1\r\n", "", "Push · subscribe"},
	} {
		t.Run(test.kind, func(t *testing.T) {
			e := structuredEvent("redis", "server_to_client", map[string]any{"kind": "push", "push_type": test.kind}, []byte(test.payload))
			r := mapOne(t, newMapper(), "s", 1, e)
			meta := r["metadata"].(map[string]any)
			if meta["pushKind"] != test.kind || r["summary"] != test.summary {
				t.Fatalf("push classified incorrectly: kind=%v summary=%v", meta["pushKind"], r["summary"])
			}
			channel, exists := meta["channel"]
			if test.channel == "" && exists || test.channel != "" && channel != test.channel {
				t.Fatalf("unexpected channel: %v", channel)
			}
		})
	}
}

func TestMapperMQTTBoundsFlagsAndClientContext(t *testing.T) {
	m := newMapper()
	connect := structuredEvent("mqtt", "client_to_server", map[string]any{"kind": "control", "packet_name": "CONNECT", "packet_type": 1, "client_id": "demo-17", "clean_session": false, "protocol_level": 4}, []byte{0x10, 0})
	mapOne(t, m, "s", 1, connect)
	publish := structuredEvent("mqtt", "client_to_server", map[string]any{"kind": "publish", "packet_name": "PUBLISH", "packet_type": 3, "qos": 0, "dup": false, "retain": false, "topic": "factory/temp", "payload_offset": 2, "payload_length": 2}, []byte{0x30, 2, 0, 255})
	r := mapOne(t, m, "s", 1, publish)
	meta := r["metadata"].(map[string]any)
	if r["payload"] != "00ff" || r["sizeBytes"] != 2 || meta["clientId"] != "demo-17" || valueString(meta["qos"]) != "0" || meta["dup"] != false {
		t.Fatal("MQTT binary/identity/flags lost")
	}
	if _, ok := meta["packetId"]; ok {
		t.Fatal("QoS0 Packet ID fabricated")
	}
	if other := mapOne(t, m, "other", 1, publish); other["metadata"].(map[string]any)["clientId"] != nil {
		t.Fatal("MQTT client ID leaked across sources")
	}
	bad := structuredEvent("mqtt", "client_to_server", map[string]any{"kind": "publish", "packet_name": "PUBLISH", "payload_offset": -1, "payload_length": 3}, []byte{0x30, 0})
	if r = mapOne(t, m, "s", 1, bad); r["family"] != "raw" {
		t.Fatal("invalid MQTT bounds accepted")
	}
}

func TestMapperMySQLTruncationAndDispatch(t *testing.T) {
	query := strings.Repeat("x", 256)
	e := mapperEvent("MySQL Query[PID=123, Comm=mysqld, Len=256/500, Status=SUCCESS]: " + query)
	e.Pid = 0
	e.Pname = ""
	r := mapOne(t, newMapper(), "s", 1, e)
	meta := r["metadata"].(map[string]any)
	if r["family"] != "mysql" || r["processPid"] != int64(123) || r["state"] != "partial" || meta["truncated"] != true || meta["dispatchCode"] != 0 || meta["sql"] != query {
		t.Fatal("MySQL capture metadata lost")
	}
	e = mapperEvent("MySQL Query[PID=123, Comm=mysqld, Len=4/4, Status=V57_FAILED]: TEST")
	r = mapOne(t, newMapper(), "s", 1, e)
	if r["outcome"] != "error" || r["metadata"].(map[string]any)["dispatchCode"] != -2 {
		t.Fatal("MySQL dispatch result lost")
	}
	if _, ok := r["response"]; ok {
		t.Fatal("SQL result set fabricated")
	}
	e = mapperEvent("MySQL Query[PID=123, Comm=mysqld, Len=4/4, Status=NOT_CAPTURED]: TEST")
	r = mapOne(t, newMapper(), "s", 1, e)
	meta = r["metadata"].(map[string]any)
	if r["outcome"] != "observed" || meta["dispatchCode"] != -1 || meta["dispatchCaptured"] != false || r["note"] == nil {
		t.Fatal("uncaptured MySQL return value was interpreted as execution failure")
	}
}

func TestMapperBoundsAndUnknownFields(t *testing.T) {
	m := newMapper()
	for i := 0; i < maxPendingRecords+10; i++ {
		e := mapperEvent("GET / HTTP/1.1\r\n\r\n")
		e.Uuid = fmt.Sprint(i)
		mapOne(t, m, "s", 1, e)
	}
	if len(m.pending) != maxPendingRecords {
		t.Fatal("pending state unbounded")
	}
	e := mapperEvent(strings.Repeat("x", maxRecordPayload+1))
	e.Pid = 0
	e.Pname = ""
	e.Timestamp = 0
	e.SrcIp = ""
	e.DstIp = ""
	r := mapOne(t, m, "s", 1, e)
	if len(r["payload"].(string)) != maxRecordPayload || r["sizeBytes"] != maxRecordPayload+1 || r["state"] != "partial" || r["processId"] != "s:unknown" {
		t.Fatal("bounded display or unknown attribution failed")
	}
	e = mapperEvent("secret")
	e.CaptureFormat = pb.CaptureFormat_CAPTURE_FORMAT_KEYLOG
	if r = mapOne(t, m, "s", 1, e); r["family"] != "raw" || r["protocol"] != "KEYLOG" {
		t.Fatal("keylog parsed as application data")
	}
	if got := m.Map("s", 1, nil, time.Now()); len(got) != 0 {
		t.Fatal("nil event should be ignored")
	}
}

func TestMapperPendingByteBudgetAndExactMetadata(t *testing.T) {
	m := newMapper()
	body := strings.Repeat("x", 128<<10)
	for i := 0; i < 40; i++ {
		e := mapperEvent(fmt.Sprintf("POST /%d HTTP/1.1\r\nContent-Length: %d\r\n\r\n%s", i, len(body), body))
		e.Uuid = fmt.Sprint(i)
		mapOne(t, m, "s", 1, e)
	}
	if m.pendingBytes > maxPendingBytes || len(m.pending) >= 40 {
		t.Fatalf("pending byte budget violated: %d bytes / %d rows", m.pendingBytes, len(m.pending))
	}
	for _, pending := range append([]pendingRecord(nil), m.pending...) {
		m.take(pending.key, true)
	}
	if m.pendingBytes != 0 || len(m.pending) != 0 {
		t.Fatal("consumed pending bytes not released")
	}
	e := structuredEvent("quic", "client_to_server", map[string]any{"kind": "stream_chunk", "offset": uint64(9007199254740993), "stream_id": uint64(18446744073709551615), "error_code": uint64(9007199254740995), "end": false}, nil)
	r := mapOne(t, m, "s", 1, e)
	meta := r["metadata"].(map[string]any)
	if meta["offset"] != "9007199254740993" || meta["errorCode"] != "9007199254740995" || r["streamId"] != "18446744073709551615" {
		t.Fatal("large metadata integer lost precision")
	}
	encoded, err := json.Marshal(r)
	if err != nil || !bytes.Contains(encoded, []byte(`"stream_id":"18446744073709551615"`)) {
		t.Fatal("upstream metadata would round in JavaScript")
	}
}

func TestMapperTruncationSurvivesAssociation(t *testing.T) {
	m := newMapper()
	req := mapperEvent("GET / HTTP/1.1\r\n\r\n")
	mapOne(t, m, "s", 1, req)
	resp := mapperEvent("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	resp.Direction = "response"
	resp.OriginalLength += 10
	r := mapOne(t, m, "s", 1, resp)
	if r["state"] != "partial" || r["metadata"].(map[string]any)["captureTruncated"] != true {
		t.Fatal("HTTP response truncation lost during merge")
	}
	redisReq := structuredEvent("redis", "client_to_server", map[string]any{"kind": "request", "request_id": 1, "command": "PING"}, []byte("*1\r\n$4\r\nPING\r\n"))
	redisReq.OriginalLength += 1
	request := mapOne(t, m, "s", 1, redisReq)
	redisResp := structuredEvent("redis", "server_to_client", map[string]any{"kind": "response", "request_id": 1, "command": "PING"}, []byte("+PONG\r\n"))
	r = mapOne(t, m, "s", 1, redisResp)
	if r["id"] != request["id"] || r["state"] != "partial" || r["metadata"].(map[string]any)["captureTruncated"] != true {
		t.Fatal("Redis request truncation lost during merge")
	}
}

func TestLoopbackResponseProcessRemainsFilterable(t *testing.T) {
	mapper := newMapper()
	request := mapperEvent("GET /process HTTP/1.1\r\nHost: localhost\r\n\r\n")
	request.Pid, request.Pname = 101, "client"
	request.ProcessArgs = []byte("client\x00--label\x00two words\x00")
	first := mapOne(t, mapper, "source", 1, request)
	response := mapperEvent("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	response.Pid, response.Pname, response.Direction = 202, "server", "response"
	response.ProcessArgs = []byte("server\x00--port\x008443\x00")
	merged := mapOne(t, mapper, "source", 1, response)
	if merged["id"] != first["id"] || merged["processPid"] != int64(101) || merged["state"] != "complete" {
		t.Fatal("process change broke HTTP association")
	}
	peer, ok := merged["responseProcess"].(processInfo)
	if !ok || peer.PID != int64(202) || peer.Name != "server" || peer.Command != `server --port 8443` {
		t.Fatal("lost response process")
	}
	store, err := NewStore(liveTestOptions("ws://127.0.0.1:1234"))
	if err != nil {
		t.Fatal(err)
	}
	store.upsert(merged, response, "source")
	processes := store.Workspace()["processes"].([]processInfo)
	if len(processes) != 2 {
		t.Fatalf("filter list has %d processes, want both local endpoints", len(processes))
	}
	if processes[0].Command != `client --label "two words"` || processes[1].Command != peer.Command {
		t.Fatal("workspace lost per-process commands")
	}
	unknown := Record{"processId": "source:unknown"}
	mergeResponseProcess(unknown, Record{"processId": "source:unknown"})
	if unknown["responseProcess"] != nil {
		t.Fatal("invented peer process")
	}
}

func TestCapturedProcessArguments(t *testing.T) {
	for _, tt := range []struct {
		name      string
		args      []byte
		truncated bool
		want      string
	}{
		{"missing", nil, false, ""},
		{"argv", []byte("app\x00\x00space value\x00"), false, `app "" "space value"`},
		{"process-title-padding", append([]byte("nginx: worker process"), bytes.Repeat([]byte{0}, 28)...), false, "nginx: worker process"},
		{"trailing-empty-args-overview", []byte("app\x00--flag\x00\x00\x00"), false, "app --flag"},
		{"single-empty", []byte{0}, false, `""`},
		{"all-zero-padding", bytes.Repeat([]byte{0}, 49), false, `""`},
		{"control-chars", []byte("app\x00line\nvalue\x00"), false, `app "line\nvalue"`},
		{"single-spaced-argument", []byte(" title \x00"), false, `" title "`},
		{"non-utf8", []byte{'a', 0, 0xff, 0}, false, `a "\xff"`},
		{"truncated", bytes.Repeat([]byte{'x'}, 256), true, strings.Repeat("x", 256)},
		{"missing-terminator", []byte("app"), false, ""},
		{"invalid-truncation", []byte("app"), true, ""},
		{"oversized", bytes.Repeat([]byte{0}, 257), false, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e := mapperEvent("GET /args HTTP/1.1\r\nHost: test.example\r\n\r\n")
			e.ProcessArgs, e.ProcessArgsTruncated = tt.args, tt.truncated
			r := mapOne(t, newMapper(), "source", 1, e)
			if valueString(r["processCommand"]) != tt.want {
				t.Fatal("incorrect argument representation")
			}
			if tt.want != "" && (!bytes.Equal(r["processArgs"].([]byte), tt.args) || r["processCommandTruncated"] != tt.truncated) {
				t.Fatal("lost original arguments or truncation flag")
			}
		})
	}
	m := newMapper()
	e := mapperEvent("GET /late HTTP/1.1\r\nHost: test.example\r\n\r\n")
	first := mapOne(t, m, "source", 1, e)
	e.Payload = []byte("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	e.ProcessArgs = []byte("same-process\x00")
	merged := mapOne(t, m, "source", 1, e)
	if merged["id"] != first["id"] || merged["processCommand"] != `same-process` || merged["responseProcess"] != nil {
		t.Fatal("late command metadata split an existing process or failed to enrich its record")
	}
}
