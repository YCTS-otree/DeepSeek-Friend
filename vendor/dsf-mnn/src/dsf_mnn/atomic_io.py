"""Crash-safe JSON receipts; incomplete temporary files are never replayed."""
import json,os
from pathlib import Path
from uuid import uuid4

def atomic_json(file,value):
    file=Path(file);file.parent.mkdir(parents=True,exist_ok=True)
    temp=file.with_name('.'+file.name+'.'+uuid4().hex+'.tmp')
    try:
        with temp.open('x',encoding='utf-8') as output:
            json.dump(value,output,ensure_ascii=False,indent=2,allow_nan=False);output.flush();os.fsync(output.fileno())
        os.replace(temp,file)
        if os.name!='nt':
            fd=os.open(file.parent,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
    finally:temp.unlink(missing_ok=True)
