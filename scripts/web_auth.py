"""Password gate for the operator console. Passwords never enter logs or exports."""
from pathlib import Path
import hashlib,hmac,secrets,threading,time,ipaddress
from urllib.parse import urlsplit

class PasswordAuth:
    def __init__(self,file,*,clock=time.monotonic):
        self.file=Path(file);self.clock=clock;self.lock=threading.RLock();self.digest=None;self.sessions={};self.failures={}
        self._refresh()
    def _refresh(self):
        # This is an operator password file, not a signing/private key. Only this
        # trusted authentication loader opens it, and only a digest is retained.
        if self.file.is_symlink() or not self.file.is_file() or self.file.stat().st_size>1024 or self.file.stat().st_nlink!=1:raise ValueError('admin-password-unavailable')
        password=self.file.read_text(encoding='utf-8-sig').rstrip('\r\n')
        if not 8<=len(password)<=256:raise ValueError('admin-password-invalid')
        digest=hashlib.sha256(password.encode()).digest()
        if digest!=self.digest:self.sessions.clear();self.digest=digest
    def bucket(self,peer):
        try:
            address=ipaddress.ip_address(peer)
            return str(ipaddress.ip_network(str(address)+'/64',strict=False)) if address.version==6 else str(address)
        except ValueError:return 'unknown'
    def login(self,password,peer):
        with self.lock:
            self._refresh();now=self.clock();key=self.bucket(peer)
            self.failures={k:v for k,v in self.failures.items() if now-v[1]<900}
            attempts,at=self.failures.get(key,(0,now))
            if attempts>=5:raise ValueError('admin-login-rate-limited')
            if not isinstance(password,str) or len(password)>256 or not hmac.compare_digest(hashlib.sha256(password.encode()).digest(),self.digest):
                if len(self.failures)>4096:self.failures.pop(next(iter(self.failures)))
                self.failures[key]=(attempts+1,at);raise ValueError('admin-login-rejected')
            self.failures.pop(key,None);token=secrets.token_urlsafe(32);csrf=secrets.token_urlsafe(32)
            self.sessions={k:v for k,v in self.sessions.items() if v[1]>now}
            if len(self.sessions)>=64:self.sessions.pop(next(iter(self.sessions)))
            self.sessions[token]=(csrf,now+43200);return token,csrf
    def session(self,token):
        with self.lock:
            try:self._refresh()
            except (OSError,ValueError):self.sessions.clear();return None
            value=self.sessions.get(token)
            if not value or value[1]<=self.clock():return None
            return value[0]
    def logout(self,token):
        with self.lock:self.sessions.pop(token,None)

def public_host(host):
    try:
        if not isinstance(host,str) or any(c in host for c in '/\\@\r\n\t ') or len(host)>300:return False
        p=urlsplit('http://'+host)
        if not p.hostname or not p.port or p.username or p.password:return False
        if p.hostname=='localhost':return True
        ipaddress.ip_address(p.hostname);return True
    except ValueError:return False
