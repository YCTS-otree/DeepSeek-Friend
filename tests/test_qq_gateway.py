import http.client
import json
import threading
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory
from launcher import Controller, LocalServer

SVG='<svg xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="M0 0h10v10H0z"/></svg>'

class GatewayUITests(unittest.TestCase):
    def setUp(self):
        self.c=Controller();self.server=LocalServer(('127.0.0.1',0),self.c);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.c.close();self.thread.join()
    def request(self,path,cookie=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        try:
            conn.request('GET',path,headers={'Cookie':cookie} if cookie else {})
            r=conn.getresponse();return r.status,r.read(),dict(r.getheaders())
        finally:conn.close()
    def test_qq_qr_is_authenticated_and_removed_after_login(self):
        with self.c.lock:self.c._event('qq',{'event':'ui.qq','phase':'waiting_qrcode','svg':SVG})
        self.assertEqual(self.request('/api/qq-qr.svg')[0],403)
        _,_,headers=self.request('/?ticket='+self.server.ticket);cookie=headers['Set-Cookie'].split(';')[0]
        status,body,headers=self.request('/api/qq-qr.svg',cookie);self.assertEqual(status,200);self.assertEqual(body.decode(),SVG);self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertFalse(self.c.snapshot()['logs'])
        with self.c.lock:self.c._event('qq',{'event':'ui.qq','phase':'ready','svg':None,'account':'99990000'})
        self.assertEqual(self.request('/api/qq-qr.svg',cookie)[0],404);self.assertEqual(self.c.snapshot()['qqAccount'],'99990000')
    def test_qq_svg_script_or_external_resource_is_rejected(self):
        for payload in ['<svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg>','<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example"/></svg>']:
            with self.c.lock:self.c._event('qq',{'event':'ui.qq','phase':'waiting_qrcode','svg':payload})
            self.assertFalse(self.c.snapshot()['qqHasQr'])
    def test_gateway_phase_and_original_error_are_private_and_never_logged(self):
        detail='当前账号(99990000)已登录,无法重复登录'
        with self.c.lock:self.c._event('qq',{'event':'ui.qq','phase':'account_in_use','svg':None,'error':'qq-gateway-account-in-use','errorDetail':detail})
        state=self.c.snapshot();self.assertEqual(state['qqLogin'],'account_in_use');self.assertEqual(state['qqErrorDetail'],detail);self.assertFalse(state['logs']);self.assertNotIn('qqCooldownSeconds',state)
        self.assertEqual(self.request('/api/state')[0],403)
        _,_,headers=self.request('/?ticket='+self.server.ticket);cookie=headers['Set-Cookie'].split(';')[0]
        self.assertEqual(json.loads(self.request('/api/state',cookie)[1])['qqErrorDetail'],detail)
        with self.c.lock:self.c._event('qq',{'event':'ui.qq','phase':'qrcode_scanned','svg':None,'errorDetail':{'unexpected':True}})
        self.assertEqual(self.c.snapshot()['qqErrorDetail'],'');self.assertEqual(self.c.snapshot()['qqLogin'],'qrcode_scanned')
    def test_one_click_start_includes_installed_qq_without_previous_flag(self):
        with TemporaryDirectory() as directory:
            root=Path(directory);binary=root/'.runtime/qq-gateway/4.18.41/node.exe';binary.parent.mkdir(parents=True);binary.touch()
            c=Controller(root=root,auto_qq=True)
            try:
                c.state['dsh']='ready'
                with patch.object(c,'_alive',return_value=True),patch.object(c,'_start_qq') as start:
                    c._start();start.assert_called_once()
                self.assertFalse((binary.parent.parent/'autostart.flag').exists())
            finally:c.close()

if __name__=='__main__':unittest.main()
