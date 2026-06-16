import base64
import ctypes
import hashlib
import http.server
import json
import os
import queue
import secrets
import shutil
import subprocess
import threading
import time
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

try:
    from PySide6.QtCore import QObject, Qt, Signal
    from PySide6.QtGui import QCloseEvent
    from PySide6.QtWidgets import (
        QApplication,
        QComboBox,
        QFrame,
        QHBoxLayout,
        QInputDialog,
        QLabel,
        QMainWindow,
        QMessageBox,
        QPushButton,
        QTextEdit,
        QVBoxLayout,
        QWidget,
    )
except ImportError as exc:
    raise SystemExit("缺少 PySide6，请先运行：python -m pip install -r requirements.txt") from exc


APP_NAME = "WorkBuddyProxy"
CONFIG_DIR = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME
CONFIG_PATH = CONFIG_DIR / "config.json"
CODEX_AUTO_MODE = "codex_auto"
MANUAL_MODE = "manual_api_key"
MODE_LABELS = {
    CODEX_AUTO_MODE: "Codex Auto（内置）",
    MANUAL_MODE: "手动 API Key（兜底）",
}
DEFAULT_CODEX_MODELS = [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
]
CODEX_CHATGPT_FALLBACK_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1"]
DEFAULT_MANUAL_MODELS = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"]
DEFAULT_CODEX_CWD = str(Path.home())
CODEX_BACKEND_URL = "https://chatgpt.com/backend-api/codex/responses"
CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback"
CODEX_OAUTH_SCOPE = "openid profile email offline_access"
CODEX_JWT_AUTH_CLAIM = "https://api.openai.com/auth"
CODEX_JWT_PROFILE_CLAIM = "https://api.openai.com/profile"


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def protect_secret(value: str) -> str:
    if not value:
        return ""
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    raw = value.encode("utf-8")
    buffer = (ctypes.c_ubyte * len(raw))(*raw)
    input_blob = DATA_BLOB(len(raw), buffer)
    output_blob = DATA_BLOB()
    ok = crypt32.CryptProtectData(
        ctypes.byref(input_blob),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(output_blob),
    )
    if not ok:
        raise ctypes.WinError()
    try:
        raw = ctypes.string_at(output_blob.pbData, output_blob.cbData)
        return base64.b64encode(raw).decode("ascii")
    finally:
        kernel32.LocalFree(output_blob.pbData)


def unprotect_secret(value: str) -> str:
    if not value:
        return ""
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    raw = base64.b64decode(value.encode("ascii"))
    buffer = (ctypes.c_ubyte * len(raw))(*raw)
    input_blob = DATA_BLOB(len(raw), buffer)
    output_blob = DATA_BLOB()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(input_blob),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(output_blob),
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData).decode("utf-8")
    finally:
        kernel32.LocalFree(output_blob.pbData)


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_config(config: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with CONFIG_PATH.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)


def codex_command() -> str | None:
    bundled = Path.home() / ".codex" / ".sandbox-bin" / "codex.exe"
    if bundled.exists():
        return str(bundled)
    return shutil.which("codex.cmd") or shutil.which("codex.exe") or shutil.which("codex")


def hidden_creation_flags() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def decode_jwt_payload(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT token.")
    payload = json.loads(base64url_decode(parts[1]).decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Invalid JWT payload.")
    return payload


def extract_codex_account_id(access_token: str) -> str:
    payload = decode_jwt_payload(access_token)
    auth = payload.get(CODEX_JWT_AUTH_CLAIM)
    if isinstance(auth, dict) and auth.get("chatgpt_account_id"):
        return str(auth["chatgpt_account_id"])
    raise ValueError("无法从 Codex OAuth token 中解析账号 ID。")


def extract_codex_email(access_token: str) -> str:
    try:
        payload = decode_jwt_payload(access_token)
    except Exception:
        return ""
    profile = payload.get(CODEX_JWT_PROFILE_CLAIM)
    if isinstance(profile, dict) and profile.get("email"):
        return str(profile["email"])
    return ""


def create_pkce_pair() -> tuple[str, str]:
    verifier = base64url_encode(os.urandom(32))
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return verifier, base64url_encode(digest)


def parse_oauth_code(value: str, expected_state: str) -> str:
    text = value.strip()
    if not text:
        raise ValueError("缺少授权码。")
    try:
        parsed = urlparse(text)
        if parsed.query:
            params = parse_qs(parsed.query)
            state = (params.get("state") or [""])[0]
            if state and state != expected_state:
                raise ValueError("OAuth state 不匹配。")
            code = (params.get("code") or [""])[0]
            if code:
                return code
    except ValueError:
        raise
    except Exception:
        pass
    if "code=" in text:
        params = parse_qs(text)
        state = (params.get("state") or [""])[0]
        if state and state != expected_state:
            raise ValueError("OAuth state 不匹配。")
        code = (params.get("code") or [""])[0]
        if code:
            return code
    if "#" in text:
        code, state = text.split("#", 1)
        if state and state != expected_state:
            raise ValueError("OAuth state 不匹配。")
        return code
    return text


def build_codex_context(developer_instructions: str, input_items: list[dict]) -> tuple[str, list[dict]]:
    content = []
    for item in input_items:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "image" and item.get("url"):
            content.append({"type": "input_image", "detail": "auto", "image_url": str(item["url"])})
        elif item.get("text"):
            content.append({"type": "input_text", "text": str(item["text"])})
    if not content:
        content = [{"type": "input_text", "text": "User:"}]
    instructions = developer_instructions.strip() or "You are a helpful assistant. Follow the user's task instructions carefully and return the requested output."
    return instructions, [{"role": "user", "content": content}]


def iter_sse_payloads(response):
    buffer = ""
    while True:
        raw = response.readline()
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace")
        if line.strip() == "":
            data_lines = []
            for item in buffer.splitlines():
                if item.startswith("data:"):
                    data_lines.append(item[5:].strip())
            buffer = ""
            data = "\n".join(data_lines).strip()
            if not data or data == "[DONE]":
                continue
            try:
                yield json.loads(data)
            except json.JSONDecodeError:
                continue
        else:
            buffer += line


def extract_response_text(response: dict) -> str:
    text = response.get("output_text")
    if isinstance(text, str) and text:
        return text
    parts: list[str] = []
    for item in response.get("output") or []:
        if not isinstance(item, dict):
            continue
        for content in item.get("content") or []:
            if isinstance(content, dict):
                value = content.get("text") or content.get("output_text")
                if isinstance(value, str):
                    parts.append(value)
    return "".join(parts)


def is_codex_model_unsupported_error(error: Exception) -> bool:
    message = str(error).lower()
    return "model is not supported" in message or "not supported when using codex with a chatgpt account" in message


def extract_text_and_images(content) -> tuple[str, list[str]]:
    if content is None:
        return "", []
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list):
        return json.dumps(content, ensure_ascii=False), []
    texts: list[str] = []
    images: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            texts.append(str(part))
            continue
        part_type = part.get("type")
        if part_type in ("text", "input_text"):
            texts.append(str(part.get("text", "")))
        elif part_type in ("image_url", "input_image"):
            image_url = part.get("image_url")
            if isinstance(image_url, dict):
                url = image_url.get("url")
            else:
                url = image_url or part.get("url")
            if url:
                images.append(str(url))
        else:
            text = part.get("text")
            if text:
                texts.append(str(text))
    return "\n".join(text for text in texts if text), images


def messages_to_codex_input(messages: list[dict]) -> tuple[str, list[dict]]:
    developer_parts: list[str] = []
    transcript_parts: list[str] = []
    image_urls: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role", "user"))
        text, images = extract_text_and_images(message.get("content"))
        image_urls.extend(images)
        if role in ("system", "developer"):
            if text:
                developer_parts.append(text)
            continue
        label = {
            "assistant": "Assistant",
            "tool": "Tool",
            "function": "Tool",
            "user": "User",
        }.get(role, role.title())
        if text:
            transcript_parts.append(f"{label}: {text}")
    prompt = "\n\n".join(transcript_parts).strip() or "User:"
    input_items = [{"type": "text", "text": prompt}]
    for url in image_urls:
        input_items.append({"type": "image", "url": url})
    return "\n\n".join(developer_parts).strip(), input_items


def response_input_to_codex_input(payload: dict) -> tuple[str, list[dict]]:
    instructions = str(payload.get("instructions", "") or "")
    value = payload.get("input", "")
    if isinstance(value, str):
        return instructions, [{"type": "text", "text": value}]
    if isinstance(value, list):
        text_parts: list[str] = []
        images: list[str] = []
        for item in value:
            if isinstance(item, dict):
                text, item_images = extract_text_and_images(item.get("content", item.get("text", item)))
                if text:
                    text_parts.append(text)
                images.extend(item_images)
            else:
                text_parts.append(str(item))
        input_items = [{"type": "text", "text": "\n\n".join(text_parts).strip() or "User:"}]
        input_items.extend({"type": "image", "url": url} for url in images)
        return instructions, input_items
    return instructions, [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]


class CodexAppServerClient:
    def __init__(self, log):
        self.log = log
        self.proc: subprocess.Popen | None = None
        self.reader_thread: threading.Thread | None = None
        self.send_lock = threading.Lock()
        self.lifecycle_lock = threading.Lock()
        self.run_lock = threading.Lock()
        self.next_id = 1
        self.pending: dict[int, queue.Queue] = {}
        self.notifications: queue.Queue = queue.Queue()

    def start(self) -> None:
        with self.lifecycle_lock:
            if self.proc and self.proc.poll() is None:
                return
            command = codex_command()
            if not command:
                raise FileNotFoundError("未找到 Codex CLI。")
            self.proc = subprocess.Popen(
                [command, "app-server"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=hidden_creation_flags(),
            )
            self.reader_thread = threading.Thread(target=self._read_loop, daemon=True)
            self.reader_thread.start()
            self.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "workbuddy_proxy",
                        "title": "WorkBuddy Proxy",
                        "version": "0.1.0",
                    },
                    "capabilities": {
                        "experimentalApi": True,
                        "optOutNotificationMethods": [],
                    },
                },
                timeout=30,
            )
            self.notify("initialized", {})

    def stop(self) -> None:
        with self.lifecycle_lock:
            if self.proc and self.proc.poll() is None:
                try:
                    self.proc.terminate()
                    self.proc.wait(timeout=4)
                except Exception:
                    if self.proc and self.proc.poll() is None:
                        self.proc.kill()
            self.proc = None

    def _read_loop(self) -> None:
        proc = self.proc
        if not proc or not proc.stdout:
            return
        for line in proc.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in message and ("result" in message or "error" in message):
                pending = self.pending.get(message["id"])
                if pending:
                    pending.put(message)
                continue
            if "id" in message and "method" in message:
                self._handle_server_request(message)
                continue
            method = message.get("method")
            params = message.get("params") or {}
            if method == "account/login/completed":
                if params.get("success"):
                    self.log("Codex 登录完成。")
                else:
                    self.log(f"Codex 登录失败：{params.get('error') or '未知错误'}")
            self.notifications.put(message)

    def _handle_server_request(self, message: dict) -> None:
        method = message.get("method")
        request_id = message.get("id")
        result: dict
        if method in ("item/commandExecution/requestApproval", "execCommandApproval"):
            result = {"decision": "cancel"}
        elif method in ("item/fileChange/requestApproval", "applyPatchApproval"):
            result = {"decision": "cancel"}
        elif method == "item/permissions/requestApproval":
            result = {"decision": "deny"}
        elif method == "item/tool/requestUserInput":
            result = {"answers": {}}
        elif method == "item/tool/call":
            result = {"success": False, "contentItems": [{"type": "inputText", "text": "Dynamic tools are disabled in WorkBuddy proxy."}]}
        elif method == "mcpServer/elicitation/request":
            result = {"action": "decline"}
        else:
            self._send({"id": request_id, "error": {"code": -32601, "message": f"Unsupported server request: {method}"}})
            return
        self._send({"id": request_id, "result": result})

    def _send(self, message: dict) -> None:
        proc = self.proc
        if not proc or not proc.stdin or proc.poll() is not None:
            raise RuntimeError("Codex app-server is not running.")
        with self.send_lock:
            proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
            proc.stdin.flush()

    def request(self, method: str, params: dict | None = None, timeout: int = 120) -> dict:
        self.start_if_needed_for_request(method)
        request_id = self.next_id
        self.next_id += 1
        pending: queue.Queue = queue.Queue(maxsize=1)
        self.pending[request_id] = pending
        self._send({"method": method, "id": request_id, "params": params or {}})
        try:
            response = pending.get(timeout=timeout)
        except queue.Empty as exc:
            raise TimeoutError(f"Codex request timed out: {method}") from exc
        finally:
            self.pending.pop(request_id, None)
        if "error" in response:
            error = response["error"]
            raise RuntimeError(error.get("message") if isinstance(error, dict) else str(error))
        return response.get("result") or {}

    def start_if_needed_for_request(self, method: str) -> None:
        if method == "initialize":
            return
        if not self.proc or self.proc.poll() is not None:
            self.start()

    def notify(self, method: str, params: dict | None = None) -> None:
        self._send({"method": method, "params": params or {}})

    def account(self) -> dict:
        return self.request("account/read", {"refreshToken": False}, timeout=30)

    def login_device_code(self) -> dict:
        self.start()
        return self.request("account/login/start", {"type": "chatgptDeviceCode"}, timeout=30)

    def list_models(self) -> list[str]:
        self.start()
        result = self.request("model/list", {"includeHidden": False, "limit": 200}, timeout=60)
        models = []
        for item in result.get("data", []):
            if isinstance(item, dict):
                model = item.get("model") or item.get("id")
                if model and model not in models:
                    models.append(str(model))
        return models

    def run_turn(self, model: str, developer_instructions: str, input_items: list[dict], timeout: int = 180, on_delta=None) -> str:
        self.start()
        with self.run_lock:
            self._drain_notifications()
            thread_result = self.request(
                "thread/start",
                {
                    "model": model,
                    "cwd": DEFAULT_CODEX_CWD,
                    "ephemeral": True,
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "developerInstructions": developer_instructions or None,
                    "baseInstructions": "You are serving as a text-only model backend for WorkBuddy. Answer the user directly. Do not run commands, modify files, request approvals, or use tools.",
                },
                timeout=60,
            )
            thread_id = thread_result.get("thread", {}).get("id")
            if not thread_id:
                raise RuntimeError("Codex did not return a thread id.")
            turn_result = self.request(
                "turn/start",
                {
                    "threadId": thread_id,
                    "input": input_items,
                    "model": model,
                    "approvalPolicy": "never",
                    "sandboxPolicy": {
                        "type": "readOnly",
                        "access": {
                            "type": "restricted",
                            "includePlatformDefaults": False,
                            "readableRoots": [],
                        },
                        "networkAccess": False,
                    },
                },
                timeout=60,
            )
            turn_id = turn_result.get("turn", {}).get("id")
            chunks: list[str] = []
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    message = self.notifications.get(timeout=1)
                except queue.Empty:
                    if self.proc and self.proc.poll() is not None:
                        raise RuntimeError("Codex app-server exited while handling request.")
                    continue
                method = message.get("method")
                params = message.get("params") or {}
                if params.get("threadId") != thread_id:
                    continue
                if turn_id and params.get("turnId") and params.get("turnId") != turn_id:
                    continue
                if method == "item/agentMessage/delta":
                    delta = params.get("delta", "")
                    if delta:
                        chunks.append(delta)
                        if on_delta:
                            on_delta(delta)
                elif method == "turn/completed":
                    turn = params.get("turn") or {}
                    if turn.get("status") == "failed":
                        error = turn.get("error") or {}
                        raise RuntimeError(error.get("message") or "Codex turn failed.")
                    return "".join(chunks).strip()
            raise TimeoutError("Codex turn timed out.")

    def _drain_notifications(self) -> None:
        while True:
            try:
                self.notifications.get_nowait()
            except queue.Empty:
                return


class CodexBackendClient:
    def __init__(self, config: dict, log):
        self.config = config
        self.log = log
        self.token_lock = threading.Lock()

    def _proxy_config(self) -> dict:
        return self.config.setdefault("proxy", {})

    def _load_secret(self, key: str) -> str:
        encrypted = self._proxy_config().get(key, "")
        if not encrypted:
            return ""
        try:
            return unprotect_secret(encrypted)
        except Exception:
            return ""

    def _save_secret(self, key: str, value: str) -> None:
        proxy_config = self._proxy_config()
        proxy_config[key] = protect_secret(value) if value else ""

    def _save_credentials(self, access: str, refresh: str, expires_at_ms: int) -> None:
        self._save_secret("codex_access_token", access)
        self._save_secret("codex_refresh_token", refresh)
        self._proxy_config()["codex_expires_at"] = int(expires_at_ms)
        save_config(self.config)

    def has_credentials(self) -> bool:
        return bool(self._load_secret("codex_access_token") and self._load_secret("codex_refresh_token"))

    def account_summary(self) -> str:
        access = self._load_secret("codex_access_token")
        if not access:
            return "未登录"
        email = extract_codex_email(access)
        expires_at = int(self._proxy_config().get("codex_expires_at") or 0)
        expires_text = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(expires_at / 1000)) if expires_at else "未知"
        return f"{email or '已保存 OAuth 凭证'} / 到期时间：{expires_text}"

    def account_details(self) -> dict:
        access = self._load_secret("codex_access_token")
        if not access:
            return {"logged_in": False, "email": "", "expires_text": ""}
        email = extract_codex_email(access)
        expires_at = int(self._proxy_config().get("codex_expires_at") or 0)
        expires_text = time.strftime("%Y/%m/%d %H:%M:%S", time.localtime(expires_at / 1000)) if expires_at else "未知"
        return {"logged_in": True, "email": email, "expires_text": expires_text}

    def login_browser(self, prompt_manual_code=None) -> str:
        verifier, challenge = create_pkce_pair()
        state = secrets.token_hex(16)
        params = {
            "response_type": "code",
            "client_id": CODEX_OAUTH_CLIENT_ID,
            "redirect_uri": CODEX_OAUTH_REDIRECT_URI,
            "scope": CODEX_OAUTH_SCOPE,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
            "originator": "pi",
        }
        auth_url = CODEX_OAUTH_AUTHORIZE_URL + "?" + urlencode(params)
        result_queue: queue.Queue = queue.Queue(maxsize=1)

        class OAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                parsed = urlparse(self.path)
                if parsed.path != "/auth/callback":
                    self.send_response(404)
                    self.end_headers()
                    return
                query = parse_qs(parsed.query)
                if (query.get("state") or [""])[0] != state:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write("State mismatch.".encode("utf-8"))
                    return
                code = (query.get("code") or [""])[0]
                if not code:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write("Missing authorization code.".encode("utf-8"))
                    return
                try:
                    result_queue.put_nowait(code)
                except queue.Full:
                    pass
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write("OpenAI Codex 登录完成，可以关闭此窗口。".encode("utf-8"))

            def log_message(self, format: str, *args) -> None:
                return

        server = None
        server_thread = None
        try:
            try:
                server = ThreadingHTTPServer(("127.0.0.1", 1455), OAuthCallbackHandler)
                server_thread = threading.Thread(target=server.serve_forever, daemon=True)
                server_thread.start()
            except OSError as exc:
                self.log(f"本地 OAuth 回调端口 1455 无法监听，将使用手动粘贴回调地址：{exc}")
            self.log("正在打开 OpenAI Codex 登录页面。")
            webbrowser.open(auth_url)
            code = ""
            try:
                code = result_queue.get(timeout=180 if server else 0.1)
            except queue.Empty:
                if prompt_manual_code:
                    manual = prompt_manual_code(auth_url)
                    if manual:
                        code = parse_oauth_code(manual, state)
            if not code:
                raise TimeoutError("OpenAI Codex 登录等待超时。")
            token = self._exchange_authorization_code(code, verifier)
            self._save_credentials(token["access_token"], token["refresh_token"], int(time.time() * 1000 + token["expires_in"] * 1000))
            return extract_codex_email(token["access_token"]) or "OpenAI Codex"
        finally:
            if server:
                server.shutdown()
                server.server_close()
            if server_thread:
                server_thread.join(timeout=2)

    def _exchange_authorization_code(self, code: str, verifier: str) -> dict:
        body = urlencode({
            "grant_type": "authorization_code",
            "client_id": CODEX_OAUTH_CLIENT_ID,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": CODEX_OAUTH_REDIRECT_URI,
        }).encode("utf-8")
        return self._token_request(body)

    def _refresh_access_token(self, refresh_token: str) -> dict:
        body = urlencode({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CODEX_OAUTH_CLIENT_ID,
        }).encode("utf-8")
        return self._token_request(body)

    def _token_request(self, body: bytes) -> dict:
        request = Request(
            CODEX_OAUTH_TOKEN_URL,
            data=body,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not payload.get("access_token") or not payload.get("refresh_token") or not payload.get("expires_in"):
            raise RuntimeError("OpenAI Codex OAuth token 响应不完整。")
        extract_codex_account_id(payload["access_token"])
        return payload

    def access_token(self, force_refresh: bool = False) -> str:
        with self.token_lock:
            access = self._load_secret("codex_access_token")
            refresh = self._load_secret("codex_refresh_token")
            expires_at = int(self._proxy_config().get("codex_expires_at") or 0)
            if not access or not refresh:
                raise RuntimeError("OpenAI Codex 尚未登录，请先点击“Codex 登录”。")
            if force_refresh or expires_at <= int(time.time() * 1000) + 120_000:
                token = self._refresh_access_token(refresh)
                self._save_credentials(token["access_token"], token["refresh_token"], int(time.time() * 1000 + token["expires_in"] * 1000))
                access = token["access_token"]
            return access

    def run_turn(self, model: str, developer_instructions: str, input_items: list[dict], timeout: int = 180, on_delta=None) -> str:
        candidates = []
        for candidate in [model, *CODEX_CHATGPT_FALLBACK_MODELS]:
            if candidate and candidate not in candidates:
                candidates.append(candidate)
        last_error: Exception | None = None
        for candidate in candidates:
            try:
                if candidate != model:
                    self.log(f"模型 {model} 不受当前 ChatGPT Codex 账号支持，自动改用 {candidate} 重试。")
                return self._run_turn_with_token(candidate, developer_instructions, input_items, timeout, on_delta, force_refresh=False)
            except RuntimeError as exc:
                last_error = exc
                if not is_codex_model_unsupported_error(exc):
                    raise
        if last_error:
            raise last_error
        raise RuntimeError("OpenAI Codex 未找到可用模型。")

    def _run_turn_with_token(self, model: str, developer_instructions: str, input_items: list[dict], timeout: int, on_delta, force_refresh: bool) -> str:
        access = self.access_token(force_refresh=force_refresh)
        account_id = extract_codex_account_id(access)
        instructions, messages = build_codex_context(developer_instructions, input_items)
        body = {
            "model": model,
            "store": False,
            "stream": True,
            "instructions": instructions,
            "input": messages,
            "text": {"verbosity": "medium"},
            "include": ["reasoning.encrypted_content"],
            "tool_choice": "none",
            "parallel_tool_calls": False,
        }
        request_id = secrets.token_hex(16)
        request = Request(
            CODEX_BACKEND_URL,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {access}",
                "chatgpt-account-id": account_id,
                "originator": "pi",
                "OpenAI-Beta": "responses=experimental",
                "Accept": "text/event-stream",
                "Content-Type": "application/json",
                "User-Agent": "WorkBuddyProxy (Windows)",
                "session_id": request_id,
                "x-client-request-id": request_id,
            },
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                return self._collect_sse_text(response, on_delta)
        except HTTPError as exc:
            if exc.code in (401, 403) and not force_refresh:
                return self._run_turn_with_token(model, developer_instructions, input_items, timeout, on_delta, force_refresh=True)
            error_text = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenAI Codex 后端请求失败：HTTP {exc.code} {error_text[:500]}") from exc

    def _collect_sse_text(self, response, on_delta=None) -> str:
        chunks: list[str] = []
        final_text = ""
        for event in iter_sse_payloads(response):
            event_type = str(event.get("type") or "")
            if event_type == "error":
                raise RuntimeError(event.get("message") or json.dumps(event, ensure_ascii=False))
            if event_type == "response.failed":
                error = (event.get("response") or {}).get("error") or {}
                raise RuntimeError(error.get("message") or "OpenAI Codex response failed.")
            delta = event.get("delta")
            if isinstance(delta, str) and ("output_text" in event_type or event_type in ("text_delta", "response.text.delta")):
                chunks.append(delta)
                if on_delta:
                    on_delta(delta)
            if event_type in ("response.completed", "response.done", "response.incomplete"):
                response_body = event.get("response")
                if isinstance(response_body, dict):
                    final_text = extract_response_text(response_body)
                break
        text = "".join(chunks).strip()
        return text or final_text.strip()


@dataclass
class ProxyState:
    route_mode: str
    api_key: str
    upstream_base_url: str
    upstream_api_key: str
    models: list[str]
    model_override: str


class OpenAIProxyHandler(BaseHTTPRequestHandler):
    server_version = "WorkBuddyProxy/2.0"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _send_raw(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_sse_chunk(self, payload: dict) -> None:
        self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def _authorized(self) -> bool:
        expected = f"Bearer {self.server.state.api_key}"
        return self.headers.get("Authorization", "") == expected

    def do_GET(self) -> None:
        if self.path.rstrip("/") in ("/health", "/v1/health"):
            self._send_json(200, {"status": "ok", "mode": self.server.state.route_mode})
            return
        if not self._authorized():
            self._send_json(401, {"error": {"message": "Invalid proxy API key"}})
            return
        if self.path.rstrip("/") == "/v1/models":
            self._send_json(
                200,
                {
                    "object": "list",
                    "data": [{"id": model, "object": "model", "owned_by": "codex-auto"} for model in self.server.state.models],
                },
            )
            return
        if self.path.startswith("/v1/models/"):
            model_id = self.path.removeprefix("/v1/models/")
            self._send_json(200, {"id": model_id, "object": "model", "owned_by": "codex-auto"})
            return
        self._send_json(404, {"error": {"message": "Unsupported endpoint"}})

    def do_POST(self) -> None:
        if not self._authorized():
            self._send_json(401, {"error": {"message": "Invalid proxy API key"}})
            return
        if self.path not in ("/v1/chat/completions", "/v1/responses", "/v1/embeddings"):
            self._send_json(404, {"error": {"message": "Unsupported endpoint"}})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
            if self.server.state.route_mode == CODEX_AUTO_MODE:
                self._handle_codex(payload)
            else:
                self._handle_manual(payload)
        except HTTPError as exc:
            error_body = exc.read() or json.dumps({"error": {"message": str(exc)}}).encode("utf-8")
            self._send_raw(exc.code, exc.headers.get("Content-Type", "application/json"), error_body)
        except (json.JSONDecodeError, ValueError) as exc:
            self._send_json(400, {"error": {"message": str(exc)}})
        except (URLError, TimeoutError, OSError, RuntimeError) as exc:
            self._send_json(502, {"error": {"message": f"Proxy request failed: {exc}"}})

    def _selected_model(self, payload: dict) -> str:
        return self.server.state.model_override or str(payload.get("model") or self.server.state.models[0])

    def _handle_codex(self, payload: dict) -> None:
        if self.path == "/v1/embeddings":
            raise ValueError("Codex Auto mode does not provide embeddings. Use manual API Key mode for embeddings.")
        model = self._selected_model(payload)
        if self.path == "/v1/chat/completions":
            messages = payload.get("messages")
            if not isinstance(messages, list):
                raise ValueError("messages must be an array.")
            developer_instructions, input_items = messages_to_codex_input(messages)
            if payload.get("stream"):
                self._stream_chat_completion(payload, model, developer_instructions, input_items)
                return
            text = self.server.codex_backend_client.run_turn(model, developer_instructions, input_items)
            self._send_json(200, self._chat_completion_response(model, text))
            return
        developer_instructions, input_items = response_input_to_codex_input(payload)
        text = self.server.codex_backend_client.run_turn(model, developer_instructions, input_items)
        self._send_json(200, self._responses_response(model, text))

    def _stream_chat_completion(self, payload: dict, model: str, developer_instructions: str, input_items: list[dict]) -> None:
        completion_id = "chatcmpl-" + secrets.token_urlsafe(12)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.close_connection = True
        self._send_sse_chunk({
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
        })

        def on_delta(delta: str) -> None:
            self._send_sse_chunk({
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}],
            })

        self.server.codex_backend_client.run_turn(model, developer_instructions, input_items, on_delta=on_delta)
        self._send_sse_chunk({
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        })
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _chat_completion_response(self, model: str, text: str) -> dict:
        return {
            "id": "chatcmpl-" + secrets.token_urlsafe(12),
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ],
        }

    def _responses_response(self, model: str, text: str) -> dict:
        return {
            "id": "resp_" + secrets.token_urlsafe(12),
            "object": "response",
            "created_at": int(time.time()),
            "model": model,
            "output_text": text,
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                }
            ],
        }

    def _handle_manual(self, payload: dict) -> None:
        state: ProxyState = self.server.state
        if not state.upstream_api_key:
            raise ValueError("Upstream API Key is not configured in manual mode.")
        forward_payload = dict(payload)
        if state.model_override:
            forward_payload["model"] = state.model_override
        request = Request(
            state.upstream_base_url.rstrip("/") + self.path,
            data=json.dumps(forward_payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {state.upstream_api_key}",
                "Content-Type": "application/json",
            },
        )
        with urlopen(request, timeout=120) as response:
            response_body = response.read()
            self._send_raw(response.status, response.headers.get("Content-Type", "application/json"), response_body)

    def log_message(self, format: str, *args) -> None:
        self.server.app_log(format % args)


class ProxyServer:
    def __init__(self, app_log, config: dict):
        self.httpd = None
        self.thread = None
        self.app_log = app_log
        self.codex_client = CodexAppServerClient(app_log)
        self.codex_backend_client = CodexBackendClient(config, app_log)

    def start(self, port: int, state: ProxyState) -> str:
        self.stop()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), OpenAIProxyHandler)
        self.httpd.state = state
        self.httpd.app_log = self.app_log
        self.httpd.codex_client = self.codex_client
        self.httpd.codex_backend_client = self.codex_backend_client
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"

    def stop(self) -> None:
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
        self.thread = None

    def close(self) -> None:
        self.stop()
        self.codex_client.stop()


class UiSignals(QObject):
    log = Signal(str)
    refresh = Signal()
    info = Signal(str, str)
    error = Signal(str, str)
    manual_code = Signal(str, object)


class WorkBuddyProxyWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.config = load_config()
        self.config.pop("account", None)
        proxy_config = self.config.setdefault("proxy", {})
        proxy_config.setdefault("api_key", "wbp-" + secrets.token_urlsafe(32))
        proxy_config.setdefault("port", 8765)
        proxy_config.setdefault("route_mode", CODEX_AUTO_MODE)
        proxy_config.setdefault("upstream_base_url", "https://api.openai.com")
        proxy_config.setdefault("models", DEFAULT_CODEX_MODELS)
        proxy_config.setdefault("model_override", "")
        if any(str(model).startswith(("openclaw", "openai/")) for model in proxy_config.get("models", [])):
            proxy_config["models"] = DEFAULT_CODEX_MODELS
            proxy_config["model_override"] = ""
        current_models = [str(model) for model in proxy_config.get("models", [])]
        if current_models and current_models[0].startswith("gpt-5.3-codex"):
            proxy_config["models"] = DEFAULT_CODEX_MODELS
        if str(proxy_config.get("model_override", "")).startswith("gpt-5.3-codex"):
            proxy_config["model_override"] = ""

        self.route_mode = proxy_config["route_mode"]
        self.base_url = ""
        self.api_key = proxy_config["api_key"]
        self.port = int(proxy_config["port"])
        self.codex_path = codex_command() or "未找到"
        self.upstream_url = proxy_config["upstream_base_url"]
        self.upstream_key = self._load_secret("upstream_api_key")
        self.models = [str(model) for model in proxy_config["models"]]
        self.model_override = str(proxy_config["model_override"])
        self.status = "未启动"
        self.signals = UiSignals()
        self.signals.log.connect(self.log)
        self.signals.refresh.connect(self.refresh_codex_panel)
        self.signals.info.connect(lambda title, body: QMessageBox.information(self, title, body))
        self.signals.error.connect(lambda title, body: QMessageBox.critical(self, title, body))
        self.signals.manual_code.connect(self._show_manual_code_dialog)
        self.proxy = ProxyServer(self.thread_log, self.config)

        self.setWindowTitle("WorkBuddy 代理助手")
        self.resize(980, 720)
        self.setMinimumSize(860, 620)
        self._build()
        self._write_settings()

    def _load_secret(self, key: str) -> str:
        encrypted = self.config.get("proxy", {}).get(key, "")
        if not encrypted:
            return ""
        try:
            return unprotect_secret(encrypted)
        except Exception:
            return ""

    def _build(self) -> None:
        root = QWidget()
        root.setObjectName("root")
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setContentsMargins(18, 18, 18, 18)
        layout.setSpacing(12)

        card = QFrame()
        card.setObjectName("card")
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(18, 18, 18, 18)
        card_layout.setSpacing(12)
        layout.addWidget(card)

        header = QHBoxLayout()
        title = QLabel("OpenAI Codex")
        title.setObjectName("title")
        self.badge_label = QLabel()
        self.badge_label.setObjectName("badge")
        self.badge_label.setAlignment(Qt.AlignCenter)
        header.addWidget(title)
        header.addStretch(1)
        header.addWidget(self.badge_label)
        card_layout.addLayout(header)

        self.model_label = QLabel()
        self.endpoint_label = QLabel("接口地址：https://chatgpt.com/backend-api")
        self.login_label = QLabel()
        for label in (self.model_label, self.endpoint_label, self.login_label):
            label.setObjectName("body")
            label.setWordWrap(True)
            card_layout.addWidget(label)

        oauth_row = QHBoxLayout()
        oauth_badge = QLabel("OAuth")
        oauth_badge.setObjectName("darkBadge")
        oauth_row.addWidget(oauth_badge)
        oauth_row.addStretch(1)
        card_layout.addLayout(oauth_row)

        self.notice_label = QLabel()
        self.notice_label.setObjectName("notice")
        self.notice_label.setWordWrap(True)
        card_layout.addWidget(self.notice_label)

        quota = QFrame()
        quota.setObjectName("quota")
        quota_layout = QVBoxLayout(quota)
        quota_layout.setContentsMargins(12, 12, 12, 12)
        quota_title = QLabel("余额")
        quota_title.setObjectName("body")
        quota_text = QLabel("当前厂商暂未接入可程序化余额查询。")
        quota_text.setObjectName("muted")
        quota_layout.addWidget(quota_title)
        quota_layout.addWidget(quota_text)
        card_layout.addWidget(quota)

        model_picker_row = QHBoxLayout()
        model_picker_label = QLabel("使用模型")
        model_picker_label.setObjectName("bodyStrong")
        self.model_combo = QComboBox()
        self.model_combo.setObjectName("modelCombo")
        self.model_combo.setMinimumHeight(38)
        self.model_combo.setMinimumWidth(320)
        self.model_combo.currentTextChanged.connect(self.change_model)
        model_picker_row.addWidget(model_picker_label)
        model_picker_row.addWidget(self.model_combo, 1)
        model_picker_row.addStretch(1)
        card_layout.addLayout(model_picker_row)
        self.model_count_label = QLabel()
        self.model_count_label.setObjectName("bodyStrong")
        card_layout.addWidget(self.model_count_label)

        codex_buttons = QHBoxLayout()
        self._add_button(codex_buttons, "管理登录", self.login_codex_async, primary=True)
        self._add_button(codex_buttons, "测试连接", self.test_connection_async)
        self._add_button(codex_buttons, "刷新模型", self.sync_models_async)
        self._add_button(codex_buttons, "刷新余额", self.refresh_balance_async)
        codex_buttons.addStretch(1)
        card_layout.addLayout(codex_buttons)

        action_row = QHBoxLayout()
        action_row.addStretch(1)
        self._add_button(action_row, "复制 WorkBuddy 配置", self.copy_workbuddy_config, primary=True)
        layout.addLayout(action_row)

        log_title = QLabel("运行日志")
        log_title.setObjectName("bodyStrong")
        layout.addWidget(log_title)
        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMinimumHeight(160)
        layout.addWidget(self.log_text, 1)
        self.setStyleSheet("""
            #root { background: #f5fffb; }
            #card {
                background: #f2fffb;
                border: 1px solid #76e4c6;
                border-radius: 12px;
            }
            #title {
                color: #061429;
                font: 700 18px "Microsoft YaHei UI";
            }
            #body, #muted, #bodyStrong {
                color: #315375;
                font: 13px "Microsoft YaHei UI";
            }
            #muted { color: #6b7f95; }
            #bodyStrong { font-weight: 700; }
            #badge {
                background: #059669;
                color: white;
                border-radius: 11px;
                padding: 4px 12px;
                font: 700 12px "Microsoft YaHei UI";
            }
            #darkBadge {
                background: #071326;
                color: white;
                border-radius: 10px;
                padding: 4px 12px;
                font: 700 12px "Microsoft YaHei UI";
            }
            #notice {
                background: #eaf3ff;
                color: #174a9c;
                border: 1px solid #b8d4ff;
                border-radius: 8px;
                padding: 10px 12px;
                font: 13px "Microsoft YaHei UI";
            }
            #quota {
                background: rgba(255, 255, 255, 0.62);
                border: 1px dashed #d8e8e4;
                border-radius: 10px;
            }
            QComboBox#modelCombo {
                background: white;
                color: #061429;
                border: 1px solid #d6ebe5;
                border-radius: 10px;
                padding: 7px 12px;
                font: 700 12px "Microsoft YaHei UI";
            }
            QComboBox#modelCombo:hover {
                border-color: #9adfcd;
            }
            QPushButton {
                background: white;
                border: 1px solid #dbe8ef;
                border-radius: 10px;
                padding: 8px 14px;
                color: #061429;
                font: 700 13px "Microsoft YaHei UI";
            }
            QPushButton:hover { background: #eef7ff; }
            QPushButton[primary="true"] {
                background: #071326;
                color: white;
                border-color: #071326;
            }
            QTextEdit {
                background: white;
                border: 1px solid #dbe8ef;
                border-radius: 10px;
                padding: 8px;
                font: 12px Consolas, "Microsoft YaHei UI";
            }
        """)
        self.refresh_codex_panel()

    def _add_button(self, layout: QHBoxLayout, text: str, callback, primary: bool = False) -> QPushButton:
        button = QPushButton(text)
        if primary:
            button.setProperty("primary", True)
        button.clicked.connect(callback)
        layout.addWidget(button)
        return button

    def selected_model(self) -> str:
        return self.model_override.strip() or self.selected_models()[0]

    def selected_models(self) -> list[str]:
        fallback = DEFAULT_CODEX_MODELS if self.route_mode == CODEX_AUTO_MODE else DEFAULT_MANUAL_MODELS
        models = [str(item).strip() for item in self.models if str(item).strip()]
        return models or fallback

    def refresh_codex_panel(self) -> None:
        self.model_label.setText(f"当前模型：{self.selected_model()}")
        details = self.proxy.codex_backend_client.account_details()
        if details.get("logged_in"):
            email = details.get("email") or "已保存 OAuth 凭证"
            self.login_label.setText(f"登录账号：{email}，有效期至 {details.get('expires_text')}")
            self.notice_label.setText("已接通 OAuth 登录、模型运行时与连接测试链路。需要先完成浏览器登录后再使用。")
            self.badge_label.setText("已配置")
        else:
            self.login_label.setText("登录账号：未登录")
            self.notice_label.setText("未接通 OAuth 登录。请点击“管理登录”完成浏览器登录。")
            self.badge_label.setText("未配置")

        models = self.selected_models()
        selected = self.selected_model()
        self.model_combo.blockSignals(True)
        self.model_combo.clear()
        self.model_combo.addItems(models)
        index = self.model_combo.findText(selected)
        self.model_combo.setCurrentIndex(index if index >= 0 else 0)
        self.model_combo.blockSignals(False)
        self.model_count_label.setText(f"下拉切换当前使用模型，共 {len(models)} 个模型")

    def change_model(self, model: str) -> None:
        if not model:
            return
        self.model_override = model
        self._write_settings()
        self.model_label.setText(f"当前模型：{self.selected_model()}")
        self.thread_log(f"已切换模型：{model}")

    def _write_settings(self) -> None:
        proxy_config = self.config.setdefault("proxy", {})
        proxy_config["route_mode"] = self.route_mode
        proxy_config["api_key"] = self.api_key
        proxy_config["port"] = int(self.port)
        proxy_config["models"] = self.selected_models()
        proxy_config["model_override"] = self.model_override.strip()
        proxy_config["upstream_base_url"] = self.upstream_url.strip().rstrip("/")
        proxy_config["upstream_api_key"] = protect_secret(self.upstream_key.strip()) if self.upstream_key.strip() else ""
        proxy_config.pop("gateway_url", None)
        proxy_config.pop("gateway_token", None)
        save_config(self.config)

    def save_settings(self) -> None:
        self._write_settings()
        self.signals.refresh.emit()
        self.thread_log("配置已保存。")

    def rotate_key(self) -> None:
        self.api_key = "wbp-" + secrets.token_urlsafe(32)
        self.save_settings()
        self.thread_log("已生成新的 WorkBuddy 代理 API Key。")

    def current_state(self) -> ProxyState:
        return ProxyState(
            route_mode=self.route_mode,
            api_key=self.api_key.strip(),
            upstream_base_url=self.upstream_url.strip().rstrip("/"),
            upstream_api_key=self.upstream_key.strip(),
            models=self.selected_models(),
            model_override=self.model_override.strip(),
        )

    def start_proxy(self) -> None:
        self._write_settings()
        try:
            if self.route_mode == CODEX_AUTO_MODE and not self.proxy.codex_backend_client.has_credentials():
                raise RuntimeError("OpenAI Codex 尚未登录，请先点击“管理登录”。")
            url = self.proxy.start(int(self.port), self.current_state())
            self.base_url = url
            self.status = "运行中"
            self.signals.refresh.emit()
            self.thread_log(f"WorkBuddy 代理已启动：{url}")
        except Exception as exc:
            message = str(exc)
            self.signals.error.emit("启动失败", f"启动失败：{message}")
            self.thread_log(f"启动失败：{message}")

    def stop_proxy(self) -> None:
        self.proxy.stop()
        self.status = "已停止"
        self.signals.refresh.emit()
        self.thread_log("WorkBuddy 代理已停止。")

    def check_codex_async(self) -> None:
        self.run_background(self.check_codex)

    def check_codex(self) -> None:
        self.codex_path = codex_command() or "未找到"
        try:
            if self.proxy.codex_backend_client.has_credentials():
                self.proxy.codex_backend_client.access_token()
                self.thread_log(f"Codex OAuth 登录态：{self.proxy.codex_backend_client.account_summary()}")
            else:
                self.thread_log("Codex OAuth 登录态：未登录，需要点击“管理登录”。")
            self.thread_log(f"Codex CLI：{'已找到，可作为兼容兜底' if self.codex_path != '未找到' else '未找到；当前 direct OAuth 流程不依赖 CLI'}")
            self.signals.refresh.emit()
        except Exception as exc:
            self.thread_log(f"Codex 检测失败：{exc}")

    def login_codex_async(self) -> None:
        self.run_background(self.login_codex)

    def login_codex(self) -> None:
        try:
            account = self.proxy.codex_backend_client.login_browser(self.prompt_codex_manual_code)
            self.thread_log(f"Codex OAuth 登录成功：{account}")
            self.signals.refresh.emit()
        except Exception as exc:
            self.thread_log(f"Codex 登录启动失败：{exc}")

    def prompt_codex_manual_code(self, auth_url: str) -> str:
        result_queue: queue.Queue = queue.Queue(maxsize=1)
        self.signals.manual_code.emit(auth_url, result_queue)
        self.thread_log(f"如浏览器未自动完成，请手动打开并登录：{auth_url}")
        return result_queue.get()

    def _show_manual_code_dialog(self, _auth_url: str, result_queue: queue.Queue) -> None:
        value, ok = QInputDialog.getText(self, "Codex 登录", "浏览器没有自动回调时，请粘贴完整回调地址或授权码：")
        result_queue.put(value if ok else "")

    def sync_models_async(self) -> None:
        self.run_background(self.sync_models)

    def sync_models(self) -> None:
        try:
            self.models = list(DEFAULT_CODEX_MODELS)
            self._write_settings()
            self.thread_log(f"已同步 direct Codex 默认模型列表：{len(self.models)} 个。")
            self.signals.refresh.emit()
        except Exception as exc:
            self.thread_log(f"同步模型列表失败：{exc}")

    def test_connection_async(self) -> None:
        self.run_background(self.test_connection)

    def test_connection(self) -> None:
        try:
            if self.route_mode == CODEX_AUTO_MODE:
                text = self.proxy.codex_backend_client.run_turn(
                    self.selected_model(),
                    "You are a connectivity test endpoint. Reply with exactly OK.",
                    [{"type": "text", "text": "请只回复 OK，用于测试连接。"}],
                    timeout=60,
                )
                if not text:
                    raise RuntimeError("Codex 已响应，但没有返回文本。")
                self.thread_log(f"测试连接成功：Codex 返回 {text[:40]}")
            else:
                payload = {
                    "model": self.selected_model(),
                    "messages": [{"role": "user", "content": "请只回复 OK，用于测试连接。"}],
                    "stream": False,
                }
                request = Request(
                    self.upstream_url.strip().rstrip("/") + "/v1/chat/completions",
                    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                    method="POST",
                    headers={
                        "Authorization": f"Bearer {self.upstream_key.strip()}",
                        "Content-Type": "application/json",
                    },
                )
                with urlopen(request, timeout=60) as response:
                    if response.status >= 400:
                        raise RuntimeError(f"HTTP {response.status}")
                self.thread_log("测试连接成功：手动上游接口可用。")
            self.signals.info.emit("测试连接", "连接 GPT 成功。")
        except Exception as exc:
            message = str(exc)
            self.thread_log(f"测试连接失败：{message}")
            self.signals.error.emit("测试连接", f"连接 GPT 失败：{message}")

    def refresh_balance_async(self) -> None:
        self.thread_log("刷新余额：OpenAI Codex 暂未提供可程序化余额查询接口。")

    def run_background(self, target) -> None:
        threading.Thread(target=target, daemon=True).start()

    def thread_log(self, message: str) -> None:
        self.signals.log.emit(message)

    def copy(self, value: str) -> None:
        QApplication.clipboard().setText(value)

    def copy_workbuddy_config(self) -> None:
        if not self.base_url:
            self.start_proxy()
            if not self.base_url:
                return
        config = {
            "接口地址": self.base_url or f"http://127.0.0.1:{self.port}/v1",
            "API Key": self.api_key,
            "模型": self.selected_models(),
        }
        self.copy(json.dumps(config, ensure_ascii=False, indent=2))
        self.thread_log("WorkBuddy 配置已复制到剪贴板。")

    def log(self, message: str) -> None:
        self.log_text.append(message)

    def closeEvent(self, event: QCloseEvent) -> None:
        self.proxy.close()
        event.accept()


if __name__ == "__main__":
    app = QApplication([])
    window = WorkBuddyProxyWindow()
    window.show()
    raise SystemExit(app.exec())
