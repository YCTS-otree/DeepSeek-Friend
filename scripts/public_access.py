"""Code-owned activation, called only after ArchiveManager verified a full DSF."""
from pathlib import Path
import json
from scripts import dsf
from scripts.web_auth import PasswordAuth

def configure(root,changes,backup):
    if set(changes)!={'enabled','port'} or type(changes['enabled']) is not bool or type(changes['port']) is not int or not 1024<=changes['port']<=65535:raise ValueError('dsf-public-config-invalid')
    if dsf.inspect(backup).get('reason')!='before-admin-public-configure':raise ValueError('dsf-public-backup-required')
    if changes['enabled']:PasswordAuth(Path(root)/'ADMIN_PWD.key')
    data,_=dsf.settings(Path(root));file=data/'admin-access.json';value={'schema':1,**changes,'backup':backup.name,'backupDigest':dsf.digest(backup)}
    temp=file.with_suffix('.partial');temp.write_text(json.dumps(value,indent=2),encoding='utf-8');temp.replace(file);return value
