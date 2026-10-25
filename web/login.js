document.getElementById('login-form').addEventListener('submit',async e=>{
 e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;
 try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});const d=await r.json();if(!r.ok)throw Error(d.error);location.replace('/');}
 catch(error){document.getElementById('login-error').textContent=error.message==='admin-login-rate-limited'?'尝试次数过多，请 15 分钟后重试。':error.message==='admin-login-rejected'?'密码不正确。':'登录暂不可用，请检查密码文件或服务状态。';}
 finally{document.getElementById('password').value='';button.disabled=false;}
});
