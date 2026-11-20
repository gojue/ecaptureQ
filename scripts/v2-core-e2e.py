#!/usr/bin/env python3
"""Real core probes -> eCaptureQ -> API/download acceptance on an authorized Linux VM.

Run on the task's designated VM only. Builds fixtures there; never downloads or
reuses an eCapture/eCaptureQ binary. Both binaries must have been built there.
Required environment: ECAPTURE_ROOT, ECAPTURE_BINARY, Q_BINARY, ARTIFACT_ROOT.
This is an integration harness, not a collector launcher exposed by the product.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def await_value(check, message, timeout=25):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = check()
            if last:
                return last
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.15)
    raise AssertionError(message)


def api(base, route, data=None):
    body = None if data is None else json.dumps(data).encode()
    request = urllib.request.Request(base + route, data=body, headers={
        "Content-Type": "application/json", "X-Ecapture-UI": "1", "Origin": base.rstrip("/")
    })
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


class Harness:
    def __init__(self):
        self.upstream = Path(os.environ["ECAPTURE_ROOT"]).resolve()
        self.capture = Path(os.environ["ECAPTURE_BINARY"]).resolve()
        self.q = Path(os.environ["Q_BINARY"]).resolve()
        root = Path(os.environ["ARTIFACT_ROOT"]).resolve()
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory = Path(tempfile.mkdtemp(prefix="q-v2-core-", dir=root))
        self.helpers = self.directory / "helpers"
        self.helpers.mkdir(mode=0o700)
        self.processes = []
        self.commands = []
        self.results = []
        self.report = {
            "environment": {"system": platform.system(), "machine": platform.machine(), "kernel": platform.release()},
            "binaries": {"ecapture_sha256": sha256(self.capture), "ecaptureq_sha256": sha256(self.q)},
            "cases": self.results,
            "scope": "OpenSSL, GoTLS and GnuTLS; BoringSSL library and desktop GUI are not covered by this harness",
        }

    def command(self, args, log, timeout=120, cwd=None):
        args = [str(a) for a in args]
        self.commands.append({"args": args, "cwd": str(cwd) if cwd else None})
        with open(log, "wb") as output:
            result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        require(result.returncode == 0, f"command {Path(args[0]).name} failed ({result.returncode}); inspect {Path(log).name}")
        return Path(log).read_bytes()

    def spawn(self, args, log, output=None):
        args = [str(a) for a in args]
        self.commands.append({"args": args})
        with open(log, "wb") as diagnostics:
            if output:
                with open(output, "wb") as data:
                    proc = subprocess.Popen(args, stdout=data, stderr=diagnostics)
            else:
                proc = subprocess.Popen(args, stdout=diagnostics, stderr=subprocess.STDOUT)
        self.processes.append(proc)
        return proc

    def stop(self, proc, normal=True):
        if proc.poll() is None:
            proc.send_signal(signal.SIGINT if normal else signal.SIGKILL)
        try:
            code = proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
            raise AssertionError("process failed to drain and stop within 20 seconds")
        if normal:
            require(code == 0, f"process exited unsuccessfully ({code})")
        return code

    def cleanup(self):
        for proc in reversed(self.processes):
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        self.write_report()

    def write_report(self):
        (self.directory / "report.json").write_text(json.dumps(self.report, indent=2) + "\n")
        # Commands can contain private paths; they stay in the local artifact
        # directory. Only the sanitized report belongs in published evidence.
        (self.directory / "commands.private.json").write_text(json.dumps(self.commands, indent=2) + "\n")

    def prepare(self):
        fixture = self.upstream / "test/e2e/fixtures"
        for name, source in {
            "tls_server": fixture / "tls_server/main.go",
            "go_client": self.upstream / "test/e2e/go_https_client.go",
            "pcapng_check": fixture / "pcapng_check/main.go",
        }.items():
            self.command(["go", "build", "-trimpath", "-o", self.helpers / name, source], self.helpers / f"{name}.build.log", cwd=self.upstream)
        for name, library in [("openssl", "openssl"), ("gnutls", "gnutls")]:
            flags = subprocess.check_output(["pkg-config", "--cflags", "--libs", library], text=True)
            self.command(["cc", "-O2", "-Wall", "-Wextra", "-Werror", "-o", self.helpers / f"{name}_client", fixture / f"c/{name}_client.c", *shlex.split(flags)], self.helpers / f"{name}.build.log")
        self.openssl = self.linked_library(self.helpers / "openssl_client", "libssl.so")
        self.gnutls = self.linked_library(self.helpers / "gnutls_client", "libgnutls.so")
        self.report["fixture_sha256"] = {name: sha256(self.helpers / name) for name in ("tls_server", "go_client", "pcapng_check", "openssl_client", "gnutls_client")}
        self.report["collector_source_sha"] = subprocess.check_output(["git", "-C", self.upstream, "rev-parse", "HEAD"], text=True).strip()
        self.report["tools"] = {}
        for name, command in {"go": ["go", "version"], "tshark": ["tshark", "--version"], "editcap": ["editcap", "--version"], "cc": ["cc", "--version"]}.items():
            lines = subprocess.check_output(command, stderr=subprocess.STDOUT, text=True).splitlines()
            self.report["tools"][name] = next(line for line in lines if line and not line.startswith("Running as user "))
        self.write_report()

    @staticmethod
    def linked_library(binary, prefix):
        text = subprocess.check_output(["ldd", binary], text=True)
        for line in text.splitlines():
            if prefix in line and "=>" in line:
                path = line.split("=>", 1)[1].strip().split()[0]
                if Path(path).is_file():
                    return str(Path(path).resolve())
        raise AssertionError(f"unable to resolve {prefix} for fixture")

    def start_server(self, directory, token):
        ready = directory / "tls.ready"
        proc = self.spawn([self.helpers / "tls_server", "--listen", "127.0.0.1:0", "--ready-file", ready, "--token", token + "_RESPONSE"], directory / "server.log")
        address = await_value(lambda: ready.read_text().strip() if ready.exists() else None, "TLS fixture did not start")
        require(proc.poll() is None, "TLS fixture exited")
        return proc, int(address.rsplit(":", 1)[1])

    def start_capture(self, directory, module, mode, server_port, ws_port, config_port=None):
        identity = {"tls": ["--libssl", self.openssl], "gotls": ["--elfpath", str(self.helpers / "go_client")], "gnutls": ["--gnutls", self.gnutls]}[module]
        args = [self.capture, module, *identity, "--model", mode, "--output", directory / "runtime.jsonl", "--stream-listen", f"ws://127.0.0.1:{ws_port}/"]
        if config_port:
            args += ["--config-listen", f"127.0.0.1:{config_port}"]
        if mode == "keylog":
            args += ["--keylogfile", directory / "collector.keys"]
        else:
            args += ["--ifname", "lo", "--pcapfile", directory / "collector.pcapng"]
            if mode == "text":
                args += ["--text-source", "pcapng"]
            args += [f"tcp port {server_port}"]
        proc = self.spawn(args, directory / "collector.log")
        def ready():
            require(proc.poll() is None, "collector exited before probe readiness")
            for path in (directory / "runtime.jsonl", directory / "collector.log"):
                if path.exists() and b"probe started successfully" in path.read_bytes().lower():
                    return True
            return False
        await_value(ready, "collector probe readiness not observed", timeout=30)
        return proc

    def start_q(self, directory, ws_port, label="q"):
        qport = port()
        base = f"http://127.0.0.1:{qport}/"
        native = directory / f"{label}-native"
        native.mkdir(mode=0o700)
        proc = self.spawn([self.q, "--listen", f"127.0.0.1:{qport}", "--mode", "live", "--data-source", f"ws://127.0.0.1:{ws_port}/", "--native-directory", native], directory / f"{label}.log")
        def ready():
            require(proc.poll() is None, "eCaptureQ exited before source readiness")
            status = api(base, "api/status")
            return status if status["sources"] and status["sources"][0]["state"] == "connected" and status["sources"][0].get("lastHeartbeatAt") else None
        status = await_value(ready, "eCaptureQ subscription handshake/heartbeat missing")
        return proc, base, status["sources"][0]["generation"]

    def traffic(self, directory, module, server_port, token, versions=("tls12", "tls13"), phase="traffic"):
        pids = {}
        for version in versions:
            marker = token + "_REQUEST_" + phase + "_" + version
            path = "/e2e?marker=" + marker
            if module == "gotls":
                args = [self.helpers / "go_client", "--url", f"https://127.0.0.1:{server_port}{path}", "--insecure", "--tls-version", "1.2" if version == "tls12" else "1.3", "--expect", token + "_RESPONSE"]
            else:
                args = [self.helpers / ("openssl_client" if module == "tls" else "gnutls_client"), "127.0.0.1", str(server_port), path, token + "_RESPONSE", version]
            proc = self.spawn(args, directory / f"{phase}-{version}.client.log")
            require(proc.wait(timeout=20) == 0, "controlled TLS client failed")
            require((token + "_RESPONSE").encode() in (directory / f"{phase}-{version}.client.log").read_bytes(), "fixture response marker missing")
            pids[marker] = proc.pid
        return pids

    def assert_text(self, base, directory, module, token, markers, generation):
        def paired():
            rows = api(base, "api/workspace?mode=live")["requests"]
            selected = [r for r in rows if any(marker in r.get("path", "") for marker in markers)]
            return selected if len(selected) >= len(markers) and all(r.get("hasRequest") and r.get("hasResponse") for r in selected) else None
        rows = await_value(paired, "Q did not expose paired SDK plaintext", timeout=35)
        for marker, pid in markers.items():
            matches = [r for r in rows if marker in r.get("path", "")]
            require(len(matches) == 1, "request was duplicated or did not correlate uniquely")
            row = matches[0]
            meta = row["metadata"]
            require(row["family"] == "http" and row["protocol"] == "HTTP/1.1" and row["state"] == "complete", "SDK formatted TEXT was not parsed as complete HTTP")
            require(row["captureGeneration"] == generation and meta.get("module") == module, "source generation or actual module lost")
            require(row["processPid"] == pid and row["processName"], "capture process identity was not preserved")
            args = base64.b64decode(row.get("processArgs", ""), validate=True)
            require(args and len(args) <= 256, "capture-time argv missing")
            require(row.get("sourceAddress") and row.get("destinationAddress") and row.get("connectionId"), "capture addresses/connection missing")
            require(row["direction"] == "client_to_server" and meta["association"] == "matched", "request/response association direction invalid")
            require(token + "_RESPONSE" in row["response"]["body"], "Q response body marker missing")
            raw = base64.b64decode(row["rawPayload"], validate=True)
            response_raw = base64.b64decode(row["responseRawPayload"], validate=True)
            require(marker.encode() in raw and (token + "_RESPONSE").encode() in response_raw, "raw formatted request/response lost")
            require(meta["length"] == len(raw) and meta["length"] > meta["originalLength"], "formatted wire length was rewritten or raw payload changed")
            require(meta.get("captureTruncated") is not True, "formatted-length difference falsely inferred truncation")
            tls = meta.get("tls", {})
            require(tls.get("version") == ("TLS 1.2" if marker.endswith("tls12") else "TLS 1.3"), "TLS protocol metadata missing")
            require(tls.get("cipher_suite") and len(tls.get("ja3", "")) == 32 and tls.get("ja4"), "TLS cipher/fingerprint metadata missing")
            detail = api(base, "api/record?" + urllib.parse.urlencode({"id": row["id"]}))
            require(detail == row, "on-demand detail differs from retained JSON export")
        (directory / "q-text.private.json").write_text(json.dumps(rows, indent=2) + "\n")
        require(not api(base, "api/artifacts"), "TEXT incorrectly created a native artifact")
        return {"paired_http": len(markers), "process_argv": True, "tls_metadata": True, "raw_payloads": True}

    def download(self, base, directory, expected_format, expected_module, state="complete", generation=None, label="q", allow_text=False):
        def finished():
            artifacts = api(base, "api/artifacts")
            matching = [a for a in artifacts if a["format"] == expected_format and (generation is None or a["generation"] == generation)]
            return matching if matching and all(a["state"] != "receiving" for a in matching) else None
        artifacts = await_value(finished, "native generation did not finish", timeout=25)
        require(len(artifacts) == 1, "one native connection created multiple artifacts")
        artifact = artifacts[0]
        require(artifact["state"] == state, f"native state {artifact['state']} != {state}: {artifact.get('error', '')}")
        require(artifact["module"] == expected_module and artifact["bytes"] > 0, "native actual module/bytes missing")
        require(artifact["filename"].endswith(".partial") == (state != "complete"), "native completion suffix is incorrect")
        route = "api/artifacts/download?" + urllib.parse.urlencode({"session": artifact["session"], "id": artifact["id"]})
        path = directory / f"{label}-export.{expected_format}{'.partial' if state != 'complete' else ''}"
        with urllib.request.urlopen(base + route, timeout=30) as response, path.open("xb") as output:
            require(artifact["filename"] in response.headers["Content-Disposition"], "download name does not match artifact state")
            shutil.copyfileobj(response, output, length=1024 * 1024)
        require(path.stat().st_size == artifact["bytes"], "download did not contain exact retained byte count")
        # A repeat download must be byte identical. Native bytes never go through
        # JSON/string/base64 export paths.
        digest = hashlib.sha256()
        with urllib.request.urlopen(base + route, timeout=30) as response:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                digest.update(chunk)
        require(digest.hexdigest() == sha256(path), "repeated native downloads changed bytes")
        (directory / f"{label}-artifact.json").write_text(json.dumps(artifact, indent=2) + "\n")
        require(allow_text or not api(base, "api/workspace?mode=live")["requests"], "native fragments entered the application-message mapper")
        return path, artifact

    def decrypt(self, directory, packet, keylog, token, markers, label, absent_markers=()):
        if keylog is None:
            # DSBs may follow their packets. Preload secrets extracted exclusively
            # from the downloaded file, never the collector's sidecar or profile.
            keylog = directory / f"{label}.embedded.keys"
            with keylog.open("xb") as output, (directory / f"{label}.editcap.log").open("wb") as errors:
                result = subprocess.run(["editcap", "--extract-secrets", packet, "-"], stdout=output, stderr=errors, timeout=20)
            require(result.returncode == 0 and keylog.stat().st_size > 0, "downloaded pcapng has no usable embedded TLS secrets")
        lines = keylog.read_bytes().splitlines()
        require(lines and all(re.fullmatch(rb"[A-Z_0-9]+ [0-9a-fA-F]{64} [0-9a-fA-F]+", line) for line in lines), "Q keylog contains non-NSS content")
        stream_data = self.command(["tshark", "-n", "-r", packet, "-Y", "tls.handshake.type == 1", "-T", "fields", "-e", "tcp.stream"], directory / f"{label}.streams.log", timeout=30)
        streams = sorted(set(line.strip() for line in stream_data.decode().splitlines() if line.strip().isdigit()))
        require(streams, "download/capture has no TLS ClientHello streams")
        plaintext = []
        for stream in streams:
            data = self.command(["tshark", "-n", "-r", packet, "-o", "tls.keylog_file:" + str(keylog), "-q", "-z", "follow,tls,ascii," + stream], directory / f"{label}.stream-{stream}.private.txt", timeout=30)
            plaintext.append(data)
        for marker in markers:
            require(any(("GET /e2e?marker=" + marker).encode() in data and (token + "_RESPONSE").encode() in data for data in plaintext), "Q export did not decrypt request and response markers in the same TLS stream")
        for marker in absent_markers:
            require(all(marker.encode() not in data for data in plaintext), "late subscriber unexpectedly received historical TLS application data")
        return {"decrypted_tls_streams": len(markers), "packet_sha256": sha256(packet), "secrets_source": "Q keylog export" if packet.suffix == ".capture" else "Q pcapng embedded DSB"}

    def matrix_case(self, module, mode):
        name = module + "-" + mode
        directory = self.directory / name
        directory.mkdir(mode=0o700)
        token = "Q" + os.urandom(6).hex() + "_" + module
        result = {"case": name, "module": module, "format": mode, "text_source": "pcapng" if mode == "text" else None}
        self.results.append(result)
        server, server_port = self.start_server(directory, token)
        packet_process = None
        packet = directory / "independent.capture"
        if mode == "keylog":
            packet_process = self.spawn(["tshark", "-n", "-i", "lo", "-f", f"tcp port {server_port}", "-w", "-"], directory / "packet-capture.log", packet)
            await_value(lambda: packet.exists() and packet.stat().st_size > 0, "independent network capture did not start")
            require(packet_process.poll() is None, "network capture exited")
        ws_port = port()
        capture = self.start_capture(directory, module, mode, server_port, ws_port)
        q, base, generation = self.start_q(directory, ws_port)
        markers = self.traffic(directory, module, server_port, token)
        if mode == "text":
            result.update(self.assert_text(base, directory, module, token, markers, generation))
        time.sleep(1.5)
        self.stop(capture)
        if packet_process:
            self.stop(packet_process)
        if mode != "text":
            exported, artifact = self.download(base, directory, mode, module, generation=generation)
            if mode == "keylog":
                data = exported.read_bytes()
                require(b"CLIENT_RANDOM " in data and b"TRAFFIC_SECRET" in data, "Q NSS export lacks TLS1.2 or TLS1.3 secrets")
                result.update(self.decrypt(directory, packet, exported, token, markers, "keylog"))
            else:
                self.command([self.helpers / "pcapng_check", "--require-dsb", exported], directory / "pcapng-validation.log")
                result.update(self.decrypt(directory, exported, None, token, markers, "pcapng"))
            result.update({"bytes": artifact["bytes"], "generation": artifact["generation"], "state": artifact["state"], "export_sha256": sha256(exported)})
        status = api(base, "api/status")
        require(status["malformed"] == 0, "Q rejected a real official v2 frame")
        require(any(log.get("module") == module for log in status["logs"]), "upstream module missing from operational logs")
        self.stop(q)
        self.stop(server)
        result["passed"] = True
        self.write_report()
        print("PASS " + name, flush=True)

    def late_subscribers(self):
        name = "tls-pcapng-two-late-subscribers"
        directory = self.directory / name
        directory.mkdir(mode=0o700)
        token = "Q" + os.urandom(6).hex() + "_late"
        result = {"case": name, "module": "tls", "format": "pcapng"}
        self.results.append(result)
        server, server_port = self.start_server(directory, token)
        ws_port = port()
        capture = self.start_capture(directory, "tls", "pcapng", server_port, ws_port)
        historical = self.traffic(directory, "tls", server_port, token, ("tls13",), "before-subscription")
        q1, base1, generation1 = self.start_q(directory, ws_port, "q1")
        q2, base2, generation2 = self.start_q(directory, ws_port, "q2")
        markers = self.traffic(directory, "tls", server_port, token, ("tls13",), "after-subscription")
        time.sleep(1.5)
        self.stop(capture)
        exports = []
        for label, base, generation in (("q1", base1, generation1), ("q2", base2, generation2)):
            exported, artifact = self.download(base, directory, "pcapng", "tls", generation=generation, label=label)
            self.command([self.helpers / "pcapng_check", "--require-dsb", exported], directory / f"{label}.blocks.log")
            self.decrypt(directory, exported, None, token, markers, label, absent_markers=historical)
            exports.append(artifact)
        require(exports[0]["id"] != exports[1]["id"] and exports[0]["session"] != exports[1]["session"], "late subscribers share artifact/session identity")
        for proc in (q1, q2, server): self.stop(proc)
        result.update({"passed": True, "independent_valid_exports": 2, "decrypt_only_new_tls_sessions": True})
        self.write_report()
        print("PASS " + name, flush=True)

    def reload_and_partial(self):
        name = "tls-reload-text-to-pcapng"
        directory = self.directory / name
        directory.mkdir(mode=0o700)
        token = "Q" + os.urandom(6).hex() + "_reload"
        result = {"case": name, "module": "tls"}
        self.results.append(result)
        server, server_port = self.start_server(directory, token)
        ws_port, config_port = port(), port()
        capture = self.start_capture(directory, "tls", "text", server_port, ws_port, config_port)
        q, base, first_generation = self.start_q(directory, ws_port)
        markers = self.traffic(directory, "tls", server_port, token, ("tls13",), "before-reload")
        self.assert_text(base, directory, "tls", token, markers, first_generation)
        response = api(f"http://127.0.0.1:{config_port}/", "tls", {"opensslpath": self.openssl, "capturemode": "pcapng", "ifname": "lo", "pcapfile": str(directory / "collector-generation2.pcapng"), "pcapfilter": f"tcp port {server_port}"})
        require(response.get("code") == 0, "collector config reload rejected")
        def reconnected():
            source = api(base, "api/status")["sources"][0]
            return source["generation"] if source["state"] == "connected" and source["generation"] > first_generation else None
        second_generation = await_value(reconnected, "Q did not reconnect after config reload", timeout=35)
        markers = self.traffic(directory, "tls", server_port, token, ("tls13",), "after-reload")
        time.sleep(1.5)
        self.stop(capture)
        exported, artifact = self.download(base, directory, "pcapng", "tls", generation=second_generation, allow_text=True)
        self.command([self.helpers / "pcapng_check", "--require-dsb", exported], directory / "blocks.log")
        self.decrypt(directory, exported, None, token, markers, "reload")
        require(all(r["captureGeneration"] == first_generation for r in api(base, "api/workspace?mode=live")["requests"]), "native generation contaminated TEXT records")
        self.stop(q)
        self.stop(server)
        result.update({"passed": True, "first_generation": first_generation, "native_generation": second_generation, "state": artifact["state"]})
        self.write_report()
        print("PASS " + name, flush=True)

        # keylog has no TC attachment, so SIGKILL does not leave this harness's
        # traffic-control program attached to loopback for subsequent cases.
        name = "tls-keylog-abnormal-close"
        directory = self.directory / name
        directory.mkdir(mode=0o700)
        result = {"case": name, "module": "tls", "format": "keylog"}
        self.results.append(result)
        server, server_port = self.start_server(directory, token)
        ws_port = port()
        capture = self.start_capture(directory, "tls", "keylog", server_port, ws_port)
        q, base, generation = self.start_q(directory, ws_port)
        self.traffic(directory, "tls", server_port, token, ("tls13",))
        await_value(lambda: any(a["bytes"] > 0 for a in api(base, "api/artifacts")), "no native keylog bytes before abnormal stop")
        self.stop(capture, normal=False)
        _, artifact = self.download(base, directory, "keylog", "tls", state="partial", generation=generation)
        require(artifact.get("error"), "abnormal close lacks a partial reason")
        self.stop(q)
        self.stop(server)
        result.update({"passed": True, "state": "partial", "partial_suffix": True})
        self.write_report()
        print("PASS " + name, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", default="tls-text,tls-keylog,tls-pcapng,gotls-text,gotls-keylog,gotls-pcapng,gnutls-text,gnutls-keylog,gnutls-pcapng,late,reload", help="comma-separated sequential cases")
    args = parser.parse_args()
    require(platform.system() == "Linux" and os.geteuid() == 0, "run as root on the authorized Linux VM; never execute this harness on the editing host")
    for name in ("ECAPTURE_ROOT", "ECAPTURE_BINARY", "Q_BINARY", "ARTIFACT_ROOT"):
        require(bool(os.environ.get(name)), "required environment variable missing: " + name)
    for name in ("go", "cc", "pkg-config", "tshark", "editcap", "ldd", "git"):
        require(shutil.which(name), "required tool missing: " + name)
    os.umask(0o077)
    harness = Harness()
    print("Private E2E evidence: " + str(harness.directory), flush=True)
    try:
        harness.prepare()
        for case in args.cases.split(","):
            if case == "late": harness.late_subscribers()
            elif case == "reload": harness.reload_and_partial()
            else:
                module, mode = case.split("-", 1)
                require(module in ("tls", "gotls", "gnutls") and mode in ("text", "keylog", "pcapng"), "unknown case")
                harness.matrix_case(module, mode)
        harness.report["passed"] = True
    except Exception as error:
        harness.report["passed"] = False
        harness.report["failure"] = str(error)
        raise
    finally:
        harness.cleanup()


if __name__ == "__main__":
    main()
