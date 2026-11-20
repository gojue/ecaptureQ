// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
// This release gate uses the upstream descriptor, never a local protocol copy.
package main

import (
	"fmt"
	"os"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v2"
	"google.golang.org/protobuf/reflect/protoreflect"
)

type fieldRequirement struct {
	name   protoreflect.Name
	number protoreflect.FieldNumber
	kind   protoreflect.Kind
	target protoreflect.FullName
	oneof  protoreflect.Name
}

func main() {
	valid := true
	fail := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "upstream protocol incompatible: "+format+"\n", args...)
		valid = false
	}
	log := (&pb.LogEntry{}).ProtoReflect().Descriptor()
	event := (&pb.Event{}).ProtoReflect().Descriptor()
	text := (&pb.TextEvent{}).ProtoReflect().Descriptor()
	keylog := (&pb.KeylogEvent{}).ProtoReflect().Descriptor()
	pcapng := (&pb.PcapngEvent{}).ProtoReflect().Descriptor()
	heartbeat := (&pb.Heartbeat{}).ProtoReflect().Descriptor()
	for _, message := range []protoreflect.MessageDescriptor{log, event, text, keylog, pcapng, heartbeat} {
		if message.ParentFile().Package() != "ecapture.v2" || message.FullName() != protoreflect.FullName("ecapture.v2."+message.Name()) {
			fail("%s must belong to ecapture.v2", message.Name())
		}
	}
	checkFields := func(message protoreflect.MessageDescriptor, expected []fieldRequirement) {
		for _, want := range expected {
			field := message.Fields().ByNumber(want.number)
			if field == nil || field.Name() != want.name || field.Kind() != want.kind || field.IsList() || field.IsMap() {
				fail("%s.%s = %d (%s)", message.Name(), want.name, want.number, want.kind)
				continue
			}
			if want.target != "" {
				var name protoreflect.FullName
				if field.Kind() == protoreflect.MessageKind {
					name = field.Message().FullName()
				}
				if field.Kind() == protoreflect.EnumKind {
					name = field.Enum().FullName()
				}
				if name != want.target {
					fail("%s.%s must use %s", message.Name(), want.name, want.target)
				}
			}
			var oneof protoreflect.Name
			if field.ContainingOneof() != nil {
				oneof = field.ContainingOneof().Name()
			}
			if oneof != want.oneof {
				fail("%s.%s oneof must be %q", message.Name(), want.name, want.oneof)
			}
		}
	}
	checkFields(log, []fieldRequirement{
		{"log_type", 1, protoreflect.EnumKind, "ecapture.v2.LogType", ""},
		{"event_payload", 2, protoreflect.MessageKind, "ecapture.v2.Event", "payload"},
		{"heartbeat_payload", 3, protoreflect.MessageKind, "ecapture.v2.Heartbeat", "payload"},
		{"run_log", 4, protoreflect.StringKind, "", "payload"},
		{"module", 5, protoreflect.StringKind, "", ""},
	})
	checkFields(event, []fieldRequirement{
		{"capture_format", 1, protoreflect.EnumKind, "ecapture.v2.CaptureFormat", ""},
		{"text", 2, protoreflect.MessageKind, "ecapture.v2.TextEvent", "content"},
		{"keylog", 3, protoreflect.MessageKind, "ecapture.v2.KeylogEvent", "content"},
		{"pcapng", 4, protoreflect.MessageKind, "ecapture.v2.PcapngEvent", "content"},
	})
	for _, requirement := range []struct {
		message protoreflect.MessageDescriptor
		name    protoreflect.Name
	}{{log, "payload"}, {event, "content"}} {
		oneof := requirement.message.Oneofs().ByName(requirement.name)
		if requirement.message.Oneofs().Len() != 1 || oneof == nil || oneof.IsSynthetic() || oneof.Fields().Len() != 3 {
			fail("%s requires oneof %s with three alternatives", requirement.message.Name(), requirement.name)
		}
	}
	checkFields(text, []fieldRequirement{
		{"timestamp", 1, protoreflect.Int64Kind, "", ""},
		{"uuid", 2, protoreflect.StringKind, "", ""},
		{"src_ip", 3, protoreflect.StringKind, "", ""},
		{"src_port", 4, protoreflect.Uint32Kind, "", ""},
		{"dst_ip", 5, protoreflect.StringKind, "", ""},
		{"dst_port", 6, protoreflect.Uint32Kind, "", ""},
		{"pid", 7, protoreflect.Int64Kind, "", ""},
		{"pname", 8, protoreflect.StringKind, "", ""},
		{"type", 9, protoreflect.Uint32Kind, "", ""},
		{"length", 10, protoreflect.Uint32Kind, "", ""},
		{"payload", 11, protoreflect.BytesKind, "", ""},
		{"sensitivity", 13, protoreflect.EnumKind, "ecapture.v2.Sensitivity", ""},
		{"direction", 14, protoreflect.StringKind, "", ""},
		{"original_length", 15, protoreflect.Uint32Kind, "", ""},
		{"stream_id", 16, protoreflect.StringKind, "", ""},
		{"sequence", 17, protoreflect.Uint64Kind, "", ""},
		{"process_args", 18, protoreflect.BytesKind, "", ""},
		{"process_args_truncated", 19, protoreflect.BoolKind, "", ""},
	})
	tls := text.Fields().ByNumber(20)
	if tls == nil || tls.Name() != "tls" || !tls.IsMap() || tls.MapKey().Kind() != protoreflect.StringKind || tls.MapValue().Kind() != protoreflect.StringKind {
		fail("TextEvent.tls = 20 must be map<string,string>")
	}
	if text.Fields().ByNumber(12) != nil || !text.ReservedRanges().Has(12) || !text.ReservedNames().Has("capture_format") {
		fail("TextEvent field 12 and capture_format must remain reserved")
	}
	for _, message := range []protoreflect.MessageDescriptor{keylog, pcapng} {
		checkFields(message, []fieldRequirement{{"data", 1, protoreflect.BytesKind, "", ""}})
	}
	checkFields(heartbeat, []fieldRequirement{
		{"timestamp", 1, protoreflect.Int64Kind, "", ""},
		{"count", 2, protoreflect.Int64Kind, "", ""},
		{"message", 3, protoreflect.StringKind, "", ""},
	})
	for _, enum := range []struct {
		descriptor protoreflect.EnumDescriptor
		names      []protoreflect.Name
	}{
		{pb.LogType(0).Descriptor(), []protoreflect.Name{"LOG_TYPE_HEARTBEAT", "LOG_TYPE_PROCESS_LOG", "LOG_TYPE_EVENT"}},
		{pb.CaptureFormat(0).Descriptor(), []protoreflect.Name{"CAPTURE_FORMAT_UNSPECIFIED", "CAPTURE_FORMAT_TEXT", "CAPTURE_FORMAT_KEYLOG", "CAPTURE_FORMAT_PCAPNG"}},
		{pb.Sensitivity(0).Descriptor(), []protoreflect.Name{"SENSITIVITY_NORMAL", "SENSITIVITY_SENSITIVE"}},
	} {
		if enum.descriptor.Values().Len() != len(enum.names) {
			fail("%s contains unsupported values", enum.descriptor.FullName())
		}
		for i, name := range enum.names {
			value := enum.descriptor.Values().ByNumber(protoreflect.EnumNumber(i))
			if value == nil || value.Name() != name {
				fail("%s.%s must equal %d", enum.descriptor.Name(), name, i)
			}
		}
	}
	if !valid {
		fmt.Fprintln(os.Stderr, "Incompatible official eCapture v2 protocol. Pin a published v2-capable dependency in go.mod/go.sum before standalone release; see docs/upstream-status.md. Do not copy or regenerate a private protocol.")
		os.Exit(1)
	}
	fmt.Println("Official eCapture v2 descriptors, oneofs, native bytes, enums and TextEvent fields verified")
}
