import argparse,json,sys
from .production import ProductionMemory
def main():
    sys.stdout.reconfigure(encoding='utf-8');parser=argparse.ArgumentParser()
    parser.add_argument('--directory',required=True);parser.add_argument('--dsf-root',required=True);parser.add_argument('--tokenizer',required=True)
    args=parser.parse_args();memory=ProductionMemory(args.directory,args.dsf_root,args.tokenizer)
    try:
        for line in sys.stdin:
            request={}
            try:
                request=json.loads(line);result=memory.handle(request);print(json.dumps({'id':request.get('id'),'result':result},ensure_ascii=False),flush=True)
            except Exception as error:
                code=str(error) if isinstance(error,ValueError) and len(str(error))<100 and all(c.isalnum() or c=='-' for c in str(error)) else 'mnn-production-operation-failed'
                print(json.dumps({'id':request.get('id'),'error':code}),flush=True)
    finally:memory.close()
if __name__=='__main__':main()
