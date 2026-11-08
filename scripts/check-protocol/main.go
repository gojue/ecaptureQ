// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
// This release gate uses the upstream descriptor, never a local protocol copy.
package main

import (
	"fmt"
	"os"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v1"
	"google.golang.org/protobuf/reflect/protoreflect"
)

func main() {
	fields := (&pb.Event{}).ProtoReflect().Descriptor().Fields()
	valid := true
	for _, want := range []struct {
		name   protoreflect.Name
		number protoreflect.FieldNumber
		kind   protoreflect.Kind
		isMap  bool
	}{{"process_args", 18, protoreflect.BytesKind, false}, {"process_args_truncated", 19, protoreflect.BoolKind, false}, {"tls", 20, protoreflect.MessageKind, true}} {
		field := fields.ByNumber(want.number)
		if field == nil || field.Name() != want.name || field.Kind() != want.kind || field.IsMap() != want.isMap {
			fmt.Fprintf(os.Stderr, "upstream protocol missing/incompatible: Event.%s = %d\n", want.name, want.number)
			valid = false
		} else if want.isMap && (field.MapKey().Kind() != protoreflect.StringKind || field.MapValue().Kind() != protoreflect.StringKind) {
			fmt.Fprintln(os.Stderr, "upstream protocol incompatible: Event.tls must be map<string,string>")
			valid = false
		}
	}
	if !valid {
		fmt.Fprintln(os.Stderr, "Incompatible official eCapture protocol: pin a published version with Event fields 18–20 in go.mod/go.sum. See docs/upstream-status.md. Do not copy/regenerate a private protocol.")
		os.Exit(1)
	}
	fmt.Println("Official eCapture Event fields 18–20 verified")
}
