import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
export function sourceRegistry(file,{kind='conversation',generation,standalone=false}={}){
 let db;
 return {allowed(id){
  if(standalone)return true;
  try{
   if(!generation||!fs.existsSync(file))return false;
   db??=new DatabaseSync(file,{readOnly:true});
   const epoch=db.prepare("SELECT value FROM meta WHERE key='mnn-generation'").get()?.value;
   const row=db.prepare('SELECT archived,kind FROM chat_sessions WHERE session=?').get(id);
   return epoch===generation&&row?.archived===0&&row.kind===kind;
  }catch{return false;}
 },close(){db?.close();db=null;}};
}
