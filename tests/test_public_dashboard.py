import unittest,tempfile,json,threading,http.client,sqlite3,time,socket
from pathlib import Path
from unittest.mock import patch
from launcher import Controller,LocalServer,IPv6Server
from scripts.web_auth import PasswordAuth
from scripts.dashboard import Dashboard,totals
from scripts.archive_manager import ArchiveManager
import test_archive_manager as helpers
from contextlib import closing

class PublicTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.password=self.root/'ADMIN_PWD.key';self.password.write_text('fixture-password',encoding='utf-8')
  self.controller=Controller(self.root);self.addCleanup(self.controller.close)
  self.auth=PasswordAuth(self.password);self.server=LocalServer(('0.0.0.0',0),self.controller,self.auth)
  self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
  self.addCleanup(self.stop)
 def stop(self):self.server.shutdown();self.server.server_close();self.thread.join()
 def request(self,method,url,body=None,cookie=None,csrf=None,origin=True):
  conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5);headers={}
  if cookie:headers['Cookie']=cookie
  if csrf:headers['X-CSRF-Token']=csrf
  if origin:headers['Origin']='http://127.0.0.1:'+str(self.server.server_port)
  if body is not None:headers['Content-Type']='application/json';body=json.dumps(body)
  try:
   conn.request(method,url,body,headers);r=conn.getresponse();return r.status,r.read(),dict(r.getheaders())
  finally:conn.close()
 def login(self):
  status,body,headers=self.request('POST','/api/login',{'password':'fixture-password'});self.assertEqual(status,200)
  cookie=headers['Set-Cookie'].split(';')[0];status,body,_=self.request('GET','/api/state',cookie=cookie);self.assertEqual(status,200)
  return cookie,json.loads(body)['csrf']
 def test_all_data_routes_require_password_and_file_paths_are_never_served(self):
  self.assertIn(b'login-form',self.request('GET','/')[1])
  for url in ('/api/state','/api/qq-qr.svg','/api/qr.svg','/api/archive-download?name=a.DSF','/app.js','/ADMIN_PWD.key'):
   self.assertEqual(self.request('GET',url)[0],401)
  cookie,csrf=self.login()
  for url in ('/ADMIN_PWD.key','/DEEPSEEK_FRIEND.key','/.runtime/home/.credentials.yaml'):self.assertEqual(self.request('GET',url,cookie=cookie)[0],404)
  self.assertEqual(self.request('POST','/api/action',{'action':'start'},cookie=cookie,csrf='bad')[0],403)
  self.assertEqual(self.request('POST','/api/action',{'action':'start'},cookie=cookie,csrf=csrf,origin=False)[0],403)
  status,body,_=self.request('POST','/api/sessions',{'action':'dashboard-status','args':{'session':'invalid'}},cookie,csrf)
  self.assertEqual(status,409);self.assertEqual(json.loads(body)['error'],'dashboard-session-invalid')
 def test_password_rotation_and_logout_revoke_sessions(self):
  cookie,csrf=self.login();self.assertEqual(self.request('POST','/api/logout',{},cookie,csrf)[0],200);self.assertEqual(self.request('GET','/api/state',cookie=cookie)[0],401)
  cookie,csrf=self.login();self.password.write_text('new-fixture-password',encoding='utf-8');self.assertEqual(self.request('GET','/api/state',cookie=cookie)[0],401)
 def test_rate_limiting_is_shared_by_ipv6_subnet(self):
  for i in range(5):
   with self.assertRaisesRegex(ValueError,'login-rejected'):self.auth.login('bad','2001:db8::'+str(i))
  with self.assertRaisesRegex(ValueError,'rate-limited'):self.auth.login('fixture-password','2001:db8::ff')
 def test_ipv6_listener_serves_same_password_gate(self):
  try:server=IPv6Server(('::1',0),self.controller,self.auth)
  except OSError:self.skipTest('IPv6 unavailable')
  thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   c=http.client.HTTPConnection('::1',server.server_port,timeout=5);c.request('GET','/api/state');r=c.getresponse();self.assertEqual(r.status,401);r.read();c.close()
  finally:server.shutdown();server.server_close();thread.join()

class FeatureTests(unittest.TestCase):
 def test_failed_backup_never_enables_public_access(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);(root/'package.json').write_text('{"version":"1.13.0"}');(root/'config.json').write_text('{"dsh":{"baseUrl":"http://127.0.0.1:9"}}')
   c=helpers.FakeController(root);manager=ArchiveManager(c);op=manager.feature('admin-public-configure',{'enabled':True,'port':3101})
   with patch('scripts.dsf.snapshot',side_effect=OSError('disk unavailable')):manager.run(op['archiveOperation'])
   self.assertEqual(manager.operations[op['archiveOperation']]['state'],'failed');self.assertFalse((root/'data/admin-access.json').exists())

class DashboardTests(unittest.TestCase):
 def test_cache_and_metrics_do_not_export_private_records_or_double_count_reasoning(self):
  self.assertEqual(totals([{'text':'{"inputTokens":10,"cacheReadTokens":20,"outputTokens":4,"reasoningTokens":3}'}])['total'],34)
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);data=root/'data';data.mkdir();(root/'config.json').write_text(json.dumps({'dataDir':str(data)}))
   with closing(sqlite3.connect(data/'interaction.sqlite')) as db:
    db.executescript('CREATE TABLE settings(k,v);CREATE TABLE private_records(n,session,kind,text,created);CREATE TABLE alarms(state);')
    db.execute("INSERT INTO private_records VALUES(1,'s','reasoning','must-not-export',1)");db.commit()
   dashboard=Dashboard(root,probe=lambda _: {'balance':{'status':'ready','balances':[{'currency':'CNY','total_balance':'2.00'}]}})
   try:
    for _ in range(20):
     value=dashboard.snapshot()
     if value['balance']['status']=='ready':break
     time.sleep(.01)
    self.assertNotIn('must-not-export',json.dumps(value));self.assertEqual(value['balance']['status'],'ready')
   finally:dashboard.close()

if __name__=='__main__':unittest.main()
