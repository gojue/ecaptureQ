// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http/httputil"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v1"
)

// Record is the presentation model shared with the mock workspace. Unknown
// protocol fields stay absent; this adapter does not reconstruct network packets.
type Record map[string]any

const (
	maxRecordPayload  = 256 << 10
	maxPendingRecords = 256
	maxPendingBytes   = 8 << 20
	maxRESPDepth      = 32
	maxRESPNodes      = 4096
)

type pendingRecord struct {
	key    string
	record Record
	bytes  int
}

type mqttIdentity struct{ key, clientID string }

type eventMapper struct {
	retained     func(Record) bool
	next         uint64
	pending      []pendingRecord
	pendingBytes int
	mqttClients  []mqttIdentity
}

func newMapper() *eventMapper { return &eventMapper{} }

// Map is called serially by a source's connector. A response returns an upsert
// using its request's ID, while unsolicited messages retain their own ID.
func (m *eventMapper) Map(sourceID string, generation uint64, event *pb.Event, receivedAt time.Time) []Record {
	if event == nil {
		return nil
	}
	m.next++
	r := newEventRecord(sourceID, generation, m.next, event, receivedAt)
	payload := event.GetPayload()
	meta := r["metadata"].(map[string]any)
	protocol := ""
	if bytes.HasPrefix(payload, []byte("[")) && bytes.Contains(payload, []byte(" encoding=hex")) {
		p, data, decoded, at, err := decodeStructured(payload)
		if err != nil {
			meta["parseError"] = err.Error()
			setPayload(r, payload)
			return []Record{r}
		}
		protocol, payload = p, data
		meta["upstream"] = decoded
		for key, value := range decoded {
			meta[key] = value
		}
		for _, key := range []string{"stream_id", "offset", "error_code", "request_id", "parent_stream_id", "push_id"} {
			if value, exists := meta[key]; exists {
				meta[key] = valueString(value)
			}
		}
		if !at.IsZero() {
			r["startedAt"] = at.Format(time.RFC3339Nano)
			meta["timestampPrecision"] = "nanoseconds"
		}
		if stream, ok := decoded["stream_id"]; ok {
			r["streamId"] = valueString(stream)
		}
	}
	setPayload(r, payload)
	if event.GetCaptureFormat() == pb.CaptureFormat_CAPTURE_FORMAT_KEYLOG || event.GetCaptureFormat() == pb.CaptureFormat_CAPTURE_FORMAT_PCAPNG {
		r["protocol"] = strings.TrimPrefix(event.GetCaptureFormat().String(), "CAPTURE_FORMAT_")
		r["operation"] = r["protocol"]
		r["summary"] = "Captured " + valueString(r["protocol"]) + " event"
		return []Record{r}
	}
	key := correlationKey(sourceID, generation, event)
	kind := valueString(meta["kind"])
	if protocol == "quic" {
		r["family"], r["protocol"], r["transport"] = "quic", "QUIC", "udp"
		for from, to := range map[string]string{"encryption_level": "encryptionLevel", "early_data": "earlyData", "error_code": "errorCode", "stream_id": "streamId", "quic_version": "version"} {
			aliasField(meta, from, to)
		}
		r["operation"] = map[string]string{"stream_chunk": "STREAM", "stream_end": "FIN", "stream_reset": "RESET", "datagram": "DATAGRAM"}[kind]
		if r["operation"] == "" {
			r["operation"] = "QUIC"
		}
		r["summary"] = valueString(r["operation"])
		if stream, ok := r["streamId"]; ok {
			r["summary"] = "Stream " + valueString(stream) + " · " + kind
		}
		if kind == "datagram" {
			delete(r, "streamId")
			delete(meta, "streamId")
		}
		return []Record{r}
	}
	if protocol == "redis" {
		return []Record{m.redisRecord(r, key, payload)}
	}
	if protocol == "mqtt" {
		return []Record{m.mqttRecord(r, key, payload)}
	}
	if sql := mysqlPattern.FindSubmatch(payload); sql != nil {
		return []Record{mysqlRecord(r, sql)}
	}
	// Incremental HTTP events retain their metadata and bytes as individual raw
	// events. They must not be mistaken for a complete HTTP transaction.
	if kind != "" && kind != "message" && kind != "informational" && kind != "push_response" {
		r["protocol"] = strings.ToUpper(protocol)
		r["operation"], r["summary"] = strings.ToUpper(kind), protocol+" · "+kind
		return []Record{r}
	}
	if message, ok := parseHTTPMessage(payload); ok {
		return []Record{m.httpRecord(r, key, event, message)}
	}
	if protocol != "" {
		r["protocol"] = strings.ToUpper(protocol)
		r["summary"] = protocol + " · " + kind
	}
	return []Record{r}
}

func newEventRecord(source string, generation, id uint64, e *pb.Event, received time.Time) Record {
	at := received.UTC()
	timeSource := "received"
	if e.GetTimestamp() > 0 {
		at = time.Unix(e.GetTimestamp(), 0).UTC()
		timeSource = "capture"
	}
	direction := e.GetDirection()
	switch direction {
	case "request":
		direction = "client_to_server"
	case "response":
		direction = "server_to_client"
	}
	src, dst := endpoint(e.GetSrcIp(), e.GetSrcPort()), endpoint(e.GetDstIp(), e.GetDstPort())
	host := e.GetDstIp()
	if direction == "server_to_client" {
		host = e.GetSrcIp()
	}
	if host == "" {
		host = "Unknown endpoint"
	}
	processName := e.GetPname()
	var processPID any
	if e.GetPid() > 0 {
		processPID = e.GetPid()
	}
	processID := processIdentity(source, e.GetPid(), processName)
	meta := map[string]any{"captureFormat": e.GetCaptureFormat().String(), "sensitivity": e.GetSensitivity().String(), "eventType": e.GetType(), "sequence": strconv.FormatUint(e.GetSequence(), 10), "originalLength": e.GetOriginalLength(), "timestampSource": timeSource, "timestampPrecision": "seconds"}
	if len(e.GetTls()) > 0 {
		tls := make(map[string]any, len(e.GetTls()))
		for key, value := range e.GetTls() {
			tls[key] = value
		}
		meta["tls"] = tls
	}
	meta["hostSource"] = "destination_ip"
	if direction == "client_to_server" || direction == "server_to_client" {
		meta["hostSource"] = "server_ip"
	}
	if host == "Unknown endpoint" {
		meta["hostSource"] = "unknown"
	}
	if e.GetPid() <= 0 && processName == "decryptor" {
		meta["upstreamPname"] = processName
		processName, processID = "未知进程", source+":unknown"
	}
	r := Record{"id": fmt.Sprintf("%s-%d-%d", source, generation, id), "sourceId": source, "captureGeneration": generation,
		"real": true, "processId": processID, "processPid": processPID, "processName": processName,
		"family": "raw", "protocol": "RAW", "transport": "", "host": host, "operation": "EVENT", "summary": "Captured event", "direction": direction,
		"state": "complete", "outcome": "observed", "startedAt": at.Format(time.RFC3339Nano), "receivedAt": received.UTC().Format(time.RFC3339Nano), "durationMs": nil,
		"connectionId": e.GetUuid(), "sourceAddress": src, "destinationAddress": dst, "localAddress": "", "remoteAddress": "", "metadata": meta}
	if args := e.GetProcessArgs(); len(args) > 0 && len(args) <= 256 && e.GetPid() > 0 &&
		((!e.GetProcessArgsTruncated() && args[len(args)-1] == 0) || (e.GetProcessArgsTruncated() && len(args) == 256)) {
		// argv snapshots have no argc: trailing empty arguments and process-title
		// zero padding cannot be distinguished. Collapse only the trailing NULs
		// in this readable overview; preserve every byte in processArgs below.
		parts := bytes.Split(bytes.TrimRight(args, "\x00"), []byte{0})
		quoted := make([]string, len(parts))
		for i, arg := range parts {
			text := string(arg)
			quoted[i] = strconv.Quote(text)
			if text != "" && strings.TrimSpace(text) == text && utf8.Valid(arg) && strings.IndexFunc(text, func(r rune) bool {
				return !unicode.IsPrint(r) || r == '"' || r == '\\' || (len(parts) > 1 && unicode.IsSpace(r))
			}) < 0 {
				quoted[i] = text
			}
		}
		r["processCommand"] = strings.Join(quoted, " ")
		r["processCommandTruncated"] = e.GetProcessArgsTruncated()
		// Keep the original argv bytes in JSON as base64, including invalid UTF-8.
		r["processArgs"] = append([]byte(nil), args...)
	}
	if direction == "client_to_server" {
		r["clientAddress"], r["serverAddress"] = src, dst
	}
	if direction == "server_to_client" {
		r["clientAddress"], r["serverAddress"] = dst, src
	}
	if e.GetStreamId() != "" {
		r["streamId"] = e.GetStreamId()
	}
	if e.GetOriginalLength() > uint32(len(e.GetPayload())) {
		meta["captureTruncated"] = true
		r["state"], r["outcome"] = "partial", "partial"
	}
	return r
}

func processIdentity(source string, pid int64, name string) string {
	if pid == 0 && name == "" {
		return source + ":unknown"
	}
	return source + ":" + strconv.FormatInt(pid, 10) + ":" + name
}

func endpoint(ip string, port uint32) string {
	if ip == "" {
		return ""
	}
	if port == 0 {
		return ip
	}
	return net.JoinHostPort(ip, strconv.FormatUint(uint64(port), 10))
}

func correlationKey(source string, generation uint64, e *pb.Event) string {
	identity := e.GetUuid()
	if identity == "" {
		a, b := endpoint(e.GetSrcIp(), e.GetSrcPort()), endpoint(e.GetDstIp(), e.GetDstPort())
		if a == "" || b == "" || e.GetSrcPort() == 0 || e.GetDstPort() == 0 {
			return ""
		}
		if a > b {
			a, b = b, a
		}
		identity = a + "/" + b
	}
	return source + "\x00" + strconv.FormatUint(generation, 10) + "\x00" + identity
}

func setPayload(r Record, data []byte) {
	r["sizeBytes"] = len(data)
	if len(data) > maxRecordPayload {
		r["metadata"].(map[string]any)["displayTruncated"] = true
		r["state"], r["outcome"] = "partial", "partial"
		data = data[:maxRecordPayload]
	}
	if utf8.Valid(data) && !bytes.ContainsRune(data, '\x00') {
		r["payload"], r["payloadEncoding"] = string(data), "utf8"
	} else {
		r["payload"], r["payloadEncoding"] = hex.EncodeToString(data), "hex"
	}
}

var structuredStart = regexp.MustCompile(`^\[([^\]]+)\] ([^ ]+) (client_to_server|server_to_client) `)
var structuredLength = regexp.MustCompile(` length=([0-9]+) encoding=hex(?: |$)`)

func decodeStructured(payload []byte) (string, []byte, map[string]any, time.Time, error) {
	line, encoded, ok := bytes.Cut(payload, []byte("\n"))
	if !ok {
		return "", nil, nil, time.Time{}, errors.New("structured event has no payload separator")
	}
	prefix := structuredStart.FindSubmatch(line)
	length := structuredLength.FindSubmatch(line)
	_, metadata, hasMetadata := bytes.Cut(line, []byte(" metadata="))
	if prefix == nil || length == nil || !hasMetadata || len(metadata) > 256<<10 {
		return "", nil, nil, time.Time{}, errors.New("invalid structured event header")
	}
	var fields map[string]any
	decoder := json.NewDecoder(bytes.NewReader(metadata))
	decoder.UseNumber()
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return "", nil, nil, time.Time{}, errors.New("invalid structured event metadata")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return "", nil, nil, time.Time{}, errors.New("trailing structured event metadata")
	}
	jsonSafeIntegers(fields)
	data, err := hex.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil {
		return "", nil, nil, time.Time{}, errors.New("invalid structured event hex payload")
	}
	declared, err := strconv.ParseUint(string(length[1]), 10, 64)
	if err != nil || declared != uint64(len(data)) {
		return "", nil, nil, time.Time{}, errors.New("structured event length mismatch")
	}
	at, err := time.Parse(time.RFC3339Nano, string(prefix[1]))
	if err != nil {
		return "", nil, nil, time.Time{}, errors.New("invalid structured event timestamp")
	}
	return strings.ToLower(string(prefix[2])), data, fields, at, nil
}

func valueString(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

// Protobuf uint64 and SDK integer metadata must not round through JavaScript's
// floating-point Number representation. Keep large values as decimal strings.
func jsonSafeIntegers(value any) any {
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			v[key] = jsonSafeIntegers(child)
		}
	case []any:
		for i, child := range v {
			v[i] = jsonSafeIntegers(child)
		}
	case json.Number:
		if !strings.ContainsAny(string(v), ".eE") {
			integer, err := strconv.ParseInt(string(v), 10, 64)
			if err != nil || integer > 9007199254740991 || integer < -9007199254740991 {
				return string(v)
			}
		}
	}
	return value
}
func aliasField(fields map[string]any, from, to string) {
	if v, ok := fields[from]; ok {
		fields[to] = v
	}
}

// Keep a distinct response-side owner when loopback endpoints are both local.
// The transaction's primary owner remains the request owner; neither is guessed.
func mergeResponseProcess(request, response Record) {
	id := valueString(response["processId"])
	if response["processPid"] == nil || id == "" {
		return
	}
	if id == valueString(request["processId"]) {
		if valueString(request["processCommand"]) == "" && valueString(response["processCommand"]) != "" {
			for _, key := range []string{"processCommand", "processCommandTruncated", "processArgs"} {
				request[key] = response[key]
			}
		}
		return
	}
	request["responseProcess"] = processInfo{ID: id, PID: response["processPid"], Name: valueString(response["processName"]), Kind: "eCaptureQ", Source: valueString(response["sourceId"]), Command: valueString(response["processCommand"]), CommandTruncated: response["processCommandTruncated"] == true}
	if args, ok := response["processArgs"]; ok {
		request["responseProcessArgs"] = args
	}
}

func copyRecord(r Record) Record {
	out := make(Record, len(r))
	for k, v := range r {
		out[k] = v
	}
	return out
}
func copyMetadata(r Record) map[string]any {
	out := make(map[string]any)
	for k, v := range r["metadata"].(map[string]any) {
		out[k] = v
	}
	return out
}
func number(value any) (int64, bool) {
	n, err := strconv.ParseInt(valueString(value), 10, 64)
	return n, err == nil
}

func (m *eventMapper) remember(key string, r Record) {
	if key == "" {
		return
	}
	encoded, err := json.Marshal(r)
	if err != nil || len(encoded) > maxPendingBytes {
		return
	}
	for len(m.pending) > 0 && (len(m.pending) >= maxPendingRecords || m.pendingBytes+len(encoded) > maxPendingBytes) {
		m.pendingBytes -= m.pending[0].bytes
		copy(m.pending, m.pending[1:])
		m.pending[len(m.pending)-1] = pendingRecord{}
		m.pending = m.pending[:len(m.pending)-1]
	}
	m.pending = append(m.pending, pendingRecord{key, r, len(encoded)})
	m.pendingBytes += len(encoded)
}
func (m *eventMapper) take(key string, consume bool) Record {
	if key == "" {
		return nil
	}
	for i, p := range m.pending {
		if p.key != key {
			continue
		}
		if consume {
			m.pendingBytes -= p.bytes
			copy(m.pending[i:], m.pending[i+1:])
			m.pending[len(m.pending)-1] = pendingRecord{}
			m.pending = m.pending[:len(m.pending)-1]
		}
		if m.retained != nil && !m.retained(p.record) {
			return nil
		}
		return p.record
	}
	return nil
}

type httpMessage struct {
	protocol, method, target, host string
	status                         int
	response                       bool
	partial                        bool
	headers                        []map[string]string
	body                           []byte
}

func parseHTTPMessage(data []byte) (httpMessage, bool) {
	var msg httpMessage
	head, body, ok := bytes.Cut(data, []byte("\r\n\r\n"))
	separator := "\r\n"
	if !ok {
		head, body, ok = bytes.Cut(data, []byte("\n\n"))
		separator = "\n"
	}
	if !ok || len(head) > 128<<10 {
		return msg, false
	}
	lines := strings.Split(string(head), separator)
	parts := strings.Fields(lines[0])
	if len(parts) < 2 {
		return msg, false
	}
	version := ""
	if strings.HasPrefix(parts[0], "HTTP/") {
		msg.response = true
		version = parts[0]
		status, err := strconv.Atoi(parts[1])
		if err != nil || status < 100 || status > 599 {
			return msg, false
		}
		msg.status = status
	} else {
		if len(parts) != 3 || !strings.HasPrefix(parts[2], "HTTP/") {
			return msg, false
		}
		for _, c := range parts[0] {
			if c < 'A' || c > 'Z' {
				return msg, false
			}
		}
		msg.method, msg.target, version = parts[0], parts[1], parts[2]
	}
	switch version {
	case "HTTP/1.0", "HTTP/1.1":
		msg.protocol = version
	case "HTTP/2", "HTTP/2.0":
		msg.protocol = "HTTP/2"
	case "HTTP/3", "HTTP/3.0":
		msg.protocol = "HTTP/3"
	default:
		return msg, false
	}
	msg.headers = make([]map[string]string, 0, len(lines)-1)
	length := int64(-1)
	chunked := false
	for _, line := range lines[1:] {
		name, value, valid := strings.Cut(line, ":")
		if !valid || name == "" {
			return msg, false
		}
		name, value = strings.ToLower(strings.TrimSpace(name)), strings.TrimSpace(value)
		msg.headers = append(msg.headers, map[string]string{"name": name, "value": value})
		switch name {
		case "host":
			msg.host = value
		case "content-length":
			var err error
			length, err = strconv.ParseInt(value, 10, 64)
			if err != nil || length < 0 {
				return msg, false
			}
		case "transfer-encoding":
			chunked = strings.EqualFold(value, "chunked")
		}
	}
	msg.body = body
	if chunked && strings.HasPrefix(msg.protocol, "HTTP/1") {
		decoded, err := io.ReadAll(io.LimitReader(httputil.NewChunkedReader(bufio.NewReader(bytes.NewReader(body))), int64(len(data))+1))
		if err != nil {
			msg.partial = true
		} else {
			msg.body = decoded
		}
	} else if length >= 0 && length > int64(len(body)) && (!msg.response || msg.status >= 200 && msg.status != 204 && msg.status != 304) {
		msg.partial = true
	}
	return msg, true
}

func httpBody(msg httpMessage) map[string]any {
	data := msg.body
	truncated := len(data) > maxRecordPayload
	if truncated {
		data = data[:maxRecordPayload]
	}
	body, encoding := string(data), "utf8"
	if !utf8.Valid(data) || bytes.ContainsRune(data, '\x00') {
		body, encoding = hex.EncodeToString(data), "hex"
	}
	return map[string]any{"headers": msg.headers, "body": body, "bodyEncoding": encoding, "byteLength": len(msg.body), "truncated": truncated}
}
func emptyHTTPBody() map[string]any {
	return map[string]any{"headers": []map[string]string{}, "body": "", "bodyEncoding": "utf8", "byteLength": 0}
}

func (m *eventMapper) httpRecord(r Record, key string, e *pb.Event, msg httpMessage) Record {
	meta := r["metadata"].(map[string]any)
	capturePartial := r["state"] == "partial"
	r["family"], r["protocol"], r["transport"] = "http", msg.protocol, "tcp"
	if msg.protocol == "HTTP/3" {
		r["transport"] = "udp"
	}
	r["method"], r["path"], r["scheme"], r["status"] = "?", "(request not observed)", "https", nil
	r["request"], r["response"] = emptyHTTPBody(), emptyHTTPBody()
	r["hasRequest"], r["hasResponse"] = false, false
	if msg.host != "" {
		r["host"] = msg.host
		meta["hostSource"] = "host_header"
	}
	if valueString(meta["authority"]) != "" {
		r["host"] = valueString(meta["authority"])
		meta["hostSource"] = "authority_metadata"
	}
	if valueString(meta["scheme"]) != "" {
		r["scheme"] = valueString(meta["scheme"])
	}
	if (msg.protocol == "HTTP/2" || msg.protocol == "HTTP/3") && e.GetStreamId() == "" && valueString(r["streamId"]) == "" {
		key = ""
		meta["associationReason"] = "missing_stream_id"
	}
	if key != "" {
		key += "\x00http\x00" + msg.protocol + "\x00" + valueString(r["streamId"]) + "\x00" + valueString(meta["tls_depth"])
	}
	if !msg.response {
		r["method"], r["path"], r["request"], r["hasRequest"] = msg.method, msg.target, httpBody(msg), true
		r["direction"], r["state"], r["outcome"] = "client_to_server", "pending", "pending"
		meta["association"] = "request-only"
		if msg.partial || capturePartial || len(msg.body) > maxRecordPayload {
			r["state"], r["outcome"] = "partial", "partial"
		}
		m.remember(key, r)
		return r
	}
	kind := valueString(meta["kind"])
	informational := msg.status < 200 && msg.status != 101
	request := m.take(key, !informational && kind != "push_response")
	if request != nil && kind != "push_response" {
		merged := copyRecord(request)
		mergeResponseProcess(merged, r)
		mergedMeta := copyMetadata(request)
		mergedMeta["association"] = "matched"
		mergedMeta["responseReceivedAt"] = r["receivedAt"]
		mergePartialFlags(mergedMeta, meta)
		// A later response can carry handshake fields that were unavailable
		// when the request was emitted. Keep an independent metadata snapshot.
		if responseTLS, ok := meta["tls"].(map[string]any); ok {
			tls := make(map[string]any)
			requestTLS, _ := mergedMeta["tls"].(map[string]any)
			for k, v := range requestTLS {
				tls[k] = v
			}
			for k, v := range responseTLS {
				if v != nil && v != "" {
					tls[k] = v
				}
			}
			mergedMeta["tls"] = tls
		}
		merged["metadata"] = mergedMeta
		merged["response"], merged["hasResponse"], merged["status"] = httpBody(msg), true, msg.status
		merged["state"], merged["outcome"] = "complete", "observed"
		if informational {
			merged["state"], merged["outcome"] = "pending", "pending"
			mergedMeta["informational"] = true
		}
		if msg.status >= 400 {
			merged["outcome"] = "error"
		}
		merged["sizeBytes"] = intValue(request["sizeBytes"]) + intValue(r["sizeBytes"])
		if (msg.partial && request["method"] != "HEAD") || capturePartial || request["state"] == "partial" || len(msg.body) > maxRecordPayload {
			merged["state"], merged["outcome"] = "partial", "partial"
		}
		return merged
	}
	r["response"], r["hasResponse"], r["status"] = httpBody(msg), true, msg.status
	r["direction"] = "server_to_client"
	meta["association"] = "response-only"
	r["note"] = "Request was not observed or is no longer retained in this capture session."
	if msg.status >= 400 {
		r["outcome"] = "error"
	}
	if msg.partial || capturePartial || len(msg.body) > maxRecordPayload {
		r["state"], r["outcome"] = "partial", "partial"
	}
	return r
}

func intValue(value any) int { n, _ := number(value); return int(n) }

func mergePartialFlags(target, source map[string]any) {
	for _, key := range []string{"captureTruncated", "displayTruncated"} {
		if source[key] == true {
			target[key] = true
		}
	}
}

var mysqlPattern = regexp.MustCompile(`(?s)^MySQL Query\[PID=([0-9]+), Comm=([^,]*), Len=([0-9]+)/([0-9]+), Status=([A-Z0-9_]+)\]: (.*)$`)

func mysqlRecord(r Record, match [][]byte) Record {
	pid, pidErr := strconv.ParseInt(string(match[1]), 10, 64)
	captured, err1 := strconv.ParseUint(string(match[3]), 10, 64)
	original, err2 := strconv.ParseUint(string(match[4]), 10, 64)
	if pidErr != nil || err1 != nil || err2 != nil || captured > original || captured > 256 || uint64(len(match[6])) > captured {
		r["metadata"].(map[string]any)["parseError"] = "invalid MySQL capture lengths"
		return r
	}
	meta := r["metadata"].(map[string]any)
	r["family"], r["protocol"], r["transport"] = "mysql", "MySQL", ""
	if r["processPid"] == nil {
		r["processPid"], r["processName"] = pid, string(match[2])
		r["processId"] = processIdentity(valueString(r["sourceId"]), pid, string(match[2]))
		meta["processSource"] = "mysql_capture_header"
	}
	query := string(match[6])
	words := strings.Fields(query)
	op := "QUERY"
	if len(words) > 0 {
		op = strings.ToUpper(words[0])
	}
	r["operation"], r["summary"] = op, query
	setPayload(r, match[6])
	meta["sql"], meta["capturedLength"], meta["originalLength"], meta["truncated"], meta["captureSource"] = query, captured, original, captured < original, "mysqld hook"
	status := string(match[5])
	meta["dispatchReturn"] = status
	if code, ok := map[string]int{"V57_FAILED": -2, "NOT_CAPTURED": -1, "SUCCESS": 0, "CLOSE_CONNECTION": 1, "WOULDBLOCK": 2}[status]; ok {
		meta["dispatchCode"] = code
		if code == -2 {
			r["outcome"] = "error"
		}
		if code == -1 {
			meta["dispatchCaptured"] = false
			r["note"] = "dispatch_command return value was not captured; execution outcome is unknown."
		}
	}
	if captured < original {
		r["state"], r["outcome"] = "partial", "partial"
	}
	return r
}

func (m *eventMapper) redisRecord(r Record, key string, payload []byte) Record {
	meta := r["metadata"].(map[string]any)
	capturePartial := r["state"] == "partial"
	kind := valueString(meta["kind"])
	r["family"], r["protocol"], r["transport"] = "redis", "Redis", "tcp"
	aliasField(meta, "request_id", "requestId")
	if len(payload) > maxRecordPayload {
		meta["parseError"] = "RESP value exceeds display limit"
		r["family"], r["operation"], r["summary"] = "raw", "RESP", "Redis · bounded raw value"
		return r
	}
	parsed, err := parseRESP(payload)
	if err != nil {
		meta["parseError"] = "invalid or unsupported RESP value"
		r["family"], r["operation"], r["summary"] = "raw", "RESP", "Redis · unparsed value"
		return r
	}
	if resp3Value(parsed) || strings.Contains("_#,(!=", valueString(meta["resp_type"])) && valueString(meta["resp_type"]) != "" {
		meta["respVersion"] = 3
	}
	requestKey := ""
	if _, exists := meta["request_id"]; exists && key != "" {
		requestKey = key + "\x00redis\x00" + valueString(meta["request_id"]) + "\x00" + valueString(meta["tls_depth"])
	}
	command := valueString(meta["command"])
	if kind == "request" {
		args := []string{}
		if values, ok := parsed["value"].([]any); ok {
			for i, v := range values {
				node, ok := v.(map[string]any)
				if !ok {
					continue
				}
				text := respText(node)
				if i == 0 && command == "" {
					command = strings.ToUpper(text)
				} else if i > 0 {
					args = append(args, text)
				}
			}
		}
		meta["kind"], meta["command"], meta["args"], meta["result"], meta["matched"] = "transaction", command, args, nil, false
		meta["requestPayload"], meta["requestPayloadEncoding"] = r["payload"], r["payloadEncoding"]
		r["operation"], r["summary"] = command, strings.TrimSpace(command+" "+strings.Join(args, " "))
		r["state"], r["outcome"] = "pending", "pending"
		if capturePartial {
			r["state"], r["outcome"] = "partial", "partial"
		}
		m.remember(requestKey, r)
		return r
	}
	meta["result"] = parsed
	if kind == "response" {
		if request := m.take(requestKey, true); request != nil {
			merged := copyRecord(request)
			mergeResponseProcess(merged, r)
			mergedMeta := copyMetadata(request)
			mergePartialFlags(mergedMeta, meta)
			mergedMeta["result"], mergedMeta["matched"] = parsed, true
			mergedMeta["responsePayload"], mergedMeta["responsePayloadEncoding"] = r["payload"], r["payloadEncoding"]
			if v, ok := meta["respVersion"]; ok {
				mergedMeta["respVersion"] = v
			}
			merged["metadata"], merged["state"], merged["outcome"] = mergedMeta, "complete", "observed"
			merged["sizeBytes"] = intValue(request["sizeBytes"]) + len(payload)
			if parsed["type"] == "error" {
				merged["outcome"] = "error"
				mergedMeta["error"] = respText(parsed)
			}
			if capturePartial || request["state"] == "partial" {
				merged["state"], merged["outcome"] = "partial", "partial"
			}
			return merged
		}
		meta["kind"], meta["matched"] = "transaction", false
		meta["responsePayload"], meta["responsePayloadEncoding"] = r["payload"], r["payloadEncoding"]
		r["note"] = "Request was not observed; response is not assigned to another command."
	}
	if command == "" {
		command = strings.ToUpper(kind)
	}
	r["operation"], r["summary"] = command, "Redis · "+kind
	if parsed["type"] == "error" {
		r["outcome"] = "error"
		meta["error"] = respText(parsed)
	}
	if kind == "push" {
		delete(meta, "channel")
		values, _ := parsed["value"].([]any)
		pushKind := respScalarAt(values, 0)
		meta["pushKind"] = pushKind
		r["summary"] = "Push"
		if pushKind != "" {
			r["summary"] = "Push · " + pushKind
		}
		channelIndex := -1
		switch pushKind {
		case "message", "smessage":
			channelIndex = 1
		case "pmessage":
			channelIndex = 2
		}
		if channel := respScalarAt(values, channelIndex); channel != "" {
			meta["channel"] = channel
			r["summary"] = "Push · " + channel
		}
	}
	return r
}

func respScalarAt(values []any, index int) string {
	if index < 0 || index >= len(values) {
		return ""
	}
	node, ok := values[index].(map[string]any)
	if !ok || node["type"] != "simple_string" && node["type"] != "bulk_string" {
		return ""
	}
	return respText(node)
}

func respText(node map[string]any) string {
	if node["encoding"] == "hex" {
		return "0x" + valueString(node["value"])
	}
	return valueString(node["value"])
}
func resp3Value(node map[string]any) bool {
	switch node["type"] {
	case "map", "set", "push", "attribute", "boolean", "double", "big_number", "verbatim_string":
		return true
	}
	return false
}

type respReader struct {
	data          []byte
	offset, nodes int
}

func parseRESP(data []byte) (map[string]any, error) {
	reader := respReader{data: data}
	node, err := reader.read(0)
	if err == nil && reader.offset != len(data) {
		err = errors.New("trailing RESP bytes")
	}
	return node, err
}
func (r *respReader) line() ([]byte, error) {
	if r.offset >= len(r.data) {
		return nil, io.ErrUnexpectedEOF
	}
	i := bytes.Index(r.data[r.offset:], []byte("\r\n"))
	if i < 0 {
		return nil, io.ErrUnexpectedEOF
	}
	line := r.data[r.offset : r.offset+i]
	r.offset += i + 2
	return line, nil
}
func (r *respReader) read(depth int) (map[string]any, error) {
	r.nodes++
	if depth > maxRESPDepth || r.nodes > maxRESPNodes {
		return nil, errors.New("RESP display limit")
	}
	if r.offset >= len(r.data) {
		return nil, io.ErrUnexpectedEOF
	}
	kind := r.data[r.offset]
	r.offset++
	line, err := r.line()
	if err != nil {
		return nil, err
	}
	node := map[string]any{}
	switch kind {
	case '+', '-':
		node["type"] = map[byte]string{'+': "simple_string", '-': "error"}[kind]
		node["value"] = string(line)
	case ':', '(':
		if len(line) == 0 {
			return nil, errors.New("empty RESP integer")
		}
		for i, c := range line {
			if (c < '0' || c > '9') && (i != 0 || c != '-' && c != '+') {
				return nil, errors.New("invalid RESP integer")
			}
		}
		node["type"] = "integer"
		if kind == '(' {
			node["type"] = "big_number"
		}
		node["value"] = string(line)
	case ',':
		node["type"], node["value"] = "double", string(line)
	case '#':
		if string(line) != "t" && string(line) != "f" {
			return nil, errors.New("invalid RESP boolean")
		}
		node["type"], node["value"] = "boolean", string(line) == "t"
	case '_':
		if len(line) != 0 {
			return nil, errors.New("invalid RESP null")
		}
		node["type"], node["value"] = "null", nil
	case '$', '!', '=':
		n, err := strconv.ParseInt(string(line), 10, 64)
		if err != nil || n < -1 {
			return nil, errors.New("invalid RESP bulk length")
		}
		if n == -1 && kind == '$' {
			node["type"], node["value"] = "null", nil
			break
		}
		if n < 0 || n > int64(len(r.data)-r.offset)-2 {
			return nil, io.ErrUnexpectedEOF
		}
		end := r.offset + int(n)
		if !bytes.Equal(r.data[end:end+2], []byte("\r\n")) {
			return nil, errors.New("invalid RESP bulk ending")
		}
		body := r.data[r.offset:end]
		r.offset = end + 2
		node["type"] = map[byte]string{'$': "bulk_string", '!': "error", '=': "verbatim_string"}[kind]
		if utf8.Valid(body) && !bytes.ContainsRune(body, '\x00') {
			node["value"] = string(body)
		} else {
			node["value"], node["encoding"] = hex.EncodeToString(body), "hex"
		}
	case '*', '%', '~', '>', '|':
		n, err := strconv.ParseInt(string(line), 10, 64)
		if err != nil || n < -1 || n > maxRESPNodes {
			return nil, errors.New("invalid RESP aggregate length")
		}
		if n == -1 && kind == '*' {
			node["type"], node["value"] = "null", nil
			break
		}
		if n < 0 {
			return nil, errors.New("invalid RESP aggregate length")
		}
		node["type"] = map[byte]string{'*': "array", '%': "map", '~': "set", '>': "push", '|': "attribute"}[kind]
		values := make([]any, 0, int(n))
		for i := int64(0); i < n; i++ {
			child, err := r.read(depth + 1)
			if err != nil {
				return nil, err
			}
			if kind == '%' || kind == '|' {
				value, err := r.read(depth + 1)
				if err != nil {
					return nil, err
				}
				values = append(values, map[string]any{"key": child, "value": value})
			} else {
				values = append(values, child)
			}
		}
		node["value"] = values
	default:
		return nil, errors.New("unsupported RESP type")
	}
	return node, nil
}

func (m *eventMapper) mqttRecord(r Record, key string, payload []byte) Record {
	meta := r["metadata"].(map[string]any)
	r["family"], r["protocol"], r["transport"] = "mqtt", "MQTT", "tcp"
	for from, to := range map[string]string{"packet_name": "packetName", "packet_type": "packetType", "client_id": "clientId", "packet_id": "packetId", "keep_alive": "keepAlive", "protocol_level": "protocolLevel", "clean_session": "cleanSession", "session_present": "sessionPresent", "return_code": "returnCode", "return_codes": "returnCodes"} {
		aliasField(meta, from, to)
	}
	name := valueString(meta["packetName"])
	r["operation"], r["summary"] = name, name
	if name == "CONNECT" && key != "" && valueString(meta["clientId"]) != "" {
		if len(m.mqttClients) >= 128 {
			m.mqttClients = m.mqttClients[1:]
		}
		m.mqttClients = append(m.mqttClients, mqttIdentity{key, valueString(meta["clientId"])})
	} else if key != "" {
		for i := len(m.mqttClients) - 1; i >= 0; i-- {
			if m.mqttClients[i].key == key {
				meta["clientId"] = m.mqttClients[i].clientID
				break
			}
		}
	}
	if topics, ok := meta["topics"].([]any); ok {
		qos, _ := meta["requested_qos"].([]any)
		converted := make([]map[string]any, 0, len(topics))
		for i, topic := range topics {
			entry := map[string]any{"topic": topic}
			if i < len(qos) {
				entry["qos"] = qos[i]
			}
			converted = append(converted, entry)
		}
		meta["topics"] = converted
	}
	meta["packetLength"] = len(payload)
	meta["packetHex"] = hex.EncodeToString(payload[:min(len(payload), maxRecordPayload)])
	if name == "PUBLISH" {
		offset, okOffset := number(meta["payload_offset"])
		length, okLength := number(meta["payload_length"])
		if !okOffset || !okLength || offset < 0 || length < 0 || offset > int64(len(payload)) || length > int64(len(payload))-offset {
			meta["parseError"] = "invalid MQTT payload bounds"
			r["family"] = "raw"
			return r
		}
		setPayload(r, payload[int(offset):int(offset+length)])
		r["summary"] = valueString(meta["topic"])
	} else {
		// Control packet bytes remain available for inspection; metadata carries
		// their decoded fields. No nonexistent business payload is manufactured.
		meta["payloadScope"] = "control-packet"
	}
	if code, ok := number(meta["returnCode"]); ok && code != 0 {
		r["outcome"] = "error"
	}
	return r
}
