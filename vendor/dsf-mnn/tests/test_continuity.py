from copy import deepcopy
import json
from test_production import add,export,Counter,Provider
from dsf_mnn.production import ProductionMemory
from dsf_mnn.semantic import normalize_export
from dsf_mnn.continuity import recent_dialogue

def transcript():
    source=export();source['surface']=[0]
    add(source,'user','来自 OTREE：明天继续昨天那道 C 题？');add(source,'assistant','行，那题我记着，明天接着来。')
    add(source,'user','CONTEXT_WINDOW_EXCEEDED');add(source,'assistant','不应恢复这个诊断轮次')
    add(source,'user','来自 Bridge：晚安');add(source,'assistant','嗯，晚安。')
    return source

def test_exact_recent_dialogue_survives_removed_surface_and_preserves_speakers_and_source(tmp_path):
    m=ProductionMemory(tmp_path,provider=Provider(),counter=Counter());source=transcript();before=deepcopy(source)
    try:
        result=m.continuity_prepare(source);context=json.loads(result['context']);text=result['context']
        assert '行，那题我记着' in text and '来自 Bridge' in text and '来自 OTREE' in text
        assert 'CONTEXT_WINDOW_EXCEEDED' not in text and '不应恢复这个诊断轮次' not in text
        assert context['untrusted_history_data'] and all(x['source_ref'] for g in context['recent_dialogue'] for x in g)
        assert source==before and result['self_update']=='noop'
        assert m.recall('CONTEXT_WINDOW_EXCEEDED')['text']==''
    finally:m.close()

def test_budget_retains_complete_dialogue_units_not_random_text_fragments():
    source=transcript();rows=recent_dialogue(source,normalize_export(source),Counter(),token_budget=1000,max_turns=1)
    assert len(rows)==1 and [x['role'] for x in rows[0]]==['user','assistant']
    assert rows[0][0]['text']=='来自 Bridge：晚安' and rows[0][1]['text']=='嗯，晚安。'

def test_checkpoint_is_not_reimported_as_fresh_human_experience(tmp_path):
    source=transcript();m=ProductionMemory(tmp_path,provider=Provider(),counter=Counter())
    try:
        prepared=m.continuity_prepare(source)
        add(source,'user',prepared['context']);source['events'][-1]['data']['source']={'kind':'mnn-continuity-context'}
        source['projected'][-1]['message']['source']={'kind':'mnn-continuity-context'}
        again=m.continuity_prepare(source)
        assert again['context']==prepared['context']
        assert 'dsf-conversation-continuity' not in m.recall('dsf-conversation-continuity')['text']
    finally:m.close()

def test_dreaming_and_private_reconstruction_keep_exact_recent_exchanges(tmp_path):
    source=export();add(source,'assistant','明天接着做，不用重新打招呼。');m=ProductionMemory(tmp_path,provider=Provider(),counter=Counter())
    try:
        normal=m.dreaming(source,day='2026-10-25');private=m.privacy_prepare(source)
        for value in (normal,private):
            recent=value['plan']['checkpoint']['recent_dialogue']
            assert recent and '明天接着做' in json.dumps(recent,ensure_ascii=False)
    finally:m.close()

def test_private_notes_reasoning_and_failed_tool_sends_are_not_restored_as_conversation():
    source=export()
    add(source,'user','给我回一句吧')
    def event(kind,data,message=None):
        seq=len(source['events']);source['events'].append({'seq':seq,'type':kind,'time':1792400000000+seq,'data':data});source['projected'].append({'seq':seq,'message':message});return seq
    event('tool/call',{'callId':'private','name':'private_note','arguments':'{"text":"私密笔记不可作为发言"}'})
    add(source,'assistant','这个私密正文没有对外发送')
    source['projected'][-1]['message']['content'].append({'type':'reasoning','text':'推理不作为原话'})
    for call,outcome in [('ok','queued'),('bad','failed')]:
        event('tool/call',{'callId':call,'name':'weixin_send_message','arguments':json.dumps({'text':'真排队的回复' if call=='ok' else '失败发送不可恢复'})})
        message={'role':'tool','callId':call,'content':[{'type':'text','text':json.dumps({'state':outcome})}]}
        event('tool/result',{'message':message},message)
    rows=recent_dialogue(source,normalize_export(source),Counter());text=json.dumps(rows,ensure_ascii=False)
    assert '真排队的回复' in text and 'queued-not-confirmed' in text
    for private in ['私密笔记不可作为发言','这个私密正文没有对外发送','推理不作为原话','失败发送不可恢复']:assert private not in text
