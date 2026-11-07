/* Same · the browser remembers the order, not the person.
   One secret key per order lives in this browser. No account, no password.
   With a real pipe behind the site (/api/ready answers JSON) everything is live.
   Without one (preview, file, no functions) the page runs a demo clock: an order is "ready" 2 minutes after it was sent. */
(function(){
  var LS='same.orders', DEMO_MS=2*60*1000;
  function read(){ try{ return JSON.parse(localStorage.getItem(LS)||'[]'); }catch(e){ return []; } }
  function write(a){ try{ localStorage.setItem(LS,JSON.stringify(a)); }catch(e){} }
  function newKey(){
    var A='abcdefghjkmnpqrstuvwxyz23456789', a=new Uint8Array(20), s='';
    if(window.crypto&&crypto.getRandomValues) crypto.getRandomValues(a); else for(var j=0;j<a.length;j++) a[j]=Math.floor(Math.random()*256);
    for(var i=0;i<a.length;i++) s+=A[a[i]%A.length];
    return s;
  }
  function get(k){ return read().filter(function(x){return x.k===k})[0]||null; }
  function save(o){ if(!o||!o.k) return o; var old=get(o.k)||{}; var m={}; Object.keys(old).forEach(function(x){m[x]=old[x]}); Object.keys(o).forEach(function(x){ if(o[x]!==undefined&&o[x]!==null&&o[x]!=='') m[x]=o[x]; }); m.created=m.created||Date.now(); var a=read().filter(function(x){return x.k!==o.k}); a.unshift(m); write(a.slice(0,12)); return m; }
  function latest(){ return read().filter(function(x){return !x.hidden})[0]||null; }
  function hide(k){ var a=read(); a.forEach(function(x){ if(x.k===k) x.hidden=true; }); write(a); }
  function etaMs(plan){ return /Everything/.test(plan||'')?30*60*1000:60*60*1000; }
  function base(){ return location.origin+location.pathname.replace(/[^\/]*$/,''); }
  function readyUrl(k){ return base()+'ready.html?k='+encodeURIComponent(k); }

  var pipe=null, pipeInfo={};
  function hasPipe(){
    if(pipe!==null) return Promise.resolve(pipe);
    if(location.protocol==='file:'){ pipe=false; return Promise.resolve(false); }
    return fetch('/api/ready?ping=1',{cache:'no-store'}).then(function(r){ if((r.headers.get('content-type')||'').indexOf('json')<0) throw 0; return r.json(); }).then(function(j){ pipeInfo=j||{}; pipe=!!(j&&j.ok&&j.r2); return pipe; }).catch(function(){ pipe=false; return false; });
  }
  var DEMO=['hotel','pool','restaurant','room_a','spa','terrace','lobby','cocktail'];
  function demoView(o){
    var readyAt=o.demoReadyAt||(o.created+DEMO_MS), ready=!!o.demoReadyAt||Date.now()>=readyAt;
    return { demo:true, k:o.k, order:o.order||'', plan:o.plan||'', place:o.place||'', created:o.created, paid:true, status:ready?'ready':'working', readyAt:readyAt, note:'',
      files: ready ? DEMO.map(function(n){ var u=base()+'img/'+n+'.webp'; return {name:n+'.webp', size:0, url:u, view:u}; }) : [], vapid:'' };
  }
  function status(k){
    var o=get(k);
    return hasPipe().then(function(live){
      if(!live) return o?demoView(o):null;
      return fetch('/api/ready?k='+encodeURIComponent(k),{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
        if(j.error) return o?demoView(o):null;
        save({k:k,order:j.order,plan:j.plan,place:j.place,created:j.created,status:j.status});
        return j;
      }).catch(function(){ return o?demoView(o):null; });
    });
  }
  function fmtTime(ms){ var d=new Date(ms); return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
  function minsLeft(ms){ return Math.max(0,Math.ceil((ms-Date.now())/60000)); }

  /* the small pill at the top of the site */
  function mountPill(){
    var o=latest(); if(!o) return;
    var st=document.createElement('style'); st.textContent='.same-pill{position:fixed;top:calc(66px + env(safe-area-inset-top,0px));left:50%;transform:translate(-50%,-140%);z-index:90;display:flex;align-items:center;gap:10px;padding:10px 14px 10px 16px;border-radius:999px;background:var(--ink,#0d0d0d);color:var(--on-ink,#f4e9e1);font:600 14px/1.2 "Figtree","Helvetica Neue",Arial,sans-serif;text-decoration:none;box-shadow:0 14px 34px rgba(13,13,13,.28);white-space:nowrap;max-width:calc(100vw - 32px);transition:transform .8s cubic-bezier(.19,1,.22,1),background .3s}.same-pill.in{transform:translate(-50%,0)}.same-pill .d{width:10px;height:10px;border-radius:50%;background:#ffb200;flex:none;animation:samepulse 1.6s ease-in-out infinite}.same-pill.ready .d{background:#1be349;animation:none;box-shadow:0 0 10px #1be349}.same-pill .x{margin-left:4px;width:22px;height:22px;border-radius:50%;border:0;background:rgba(128,128,128,.28);color:inherit;font:600 14px/1 sans-serif;cursor:pointer;display:grid;place-items:center}.same-pill .t{overflow:hidden;text-overflow:ellipsis}@keyframes samepulse{0%,100%{opacity:1}50%{opacity:.35}}@media(min-width:1100px){.same-pill{top:calc(14px + env(safe-area-inset-top,0px));left:calc(50% + 120px)}}';
    document.head.appendChild(st);
    var a=document.createElement('a'); a.className='same-pill'; a.href=readyUrl(o.k); a.setAttribute('aria-live','polite');
    a.innerHTML='<span class="d"></span><span class="t">Checking your order…</span><button class="x" type="button" aria-label="Hide">×</button>';
    document.body.appendChild(a);
    a.querySelector('.x').addEventListener('click',function(e){ e.preventDefault(); e.stopPropagation(); a.classList.remove('in'); hide(o.k); });
    function paint(j){
      if(!j){ a.remove(); return; }
      var t=a.querySelector('.t');
      if(j.status==='ready'){ a.classList.add('ready'); t.textContent='Your photos are ready  ↗'; }
      else { a.classList.remove('ready'); t.textContent='We’re on it · ready by '+fmtTime(j.readyAt)+(j.demo?' (demo clock)':''); }
      if(!a.classList.contains('in')) setTimeout(function(){ a.classList.add('in'); },900);
    }
    function tick(){ status(o.k).then(paint); }
    tick(); setInterval(tick,30000);
  }

  window.Same={newKey:newKey,save:save,get:get,latest:latest,hide:hide,list:read,status:status,hasPipe:hasPipe,pipeInfo:function(){return pipeInfo},etaMs:etaMs,readyUrl:readyUrl,base:base,fmtTime:fmtTime,minsLeft:minsLeft,DEMO_MS:DEMO_MS,mountPill:mountPill,demoReady:function(k){ var o=get(k); if(o){ o.demoReadyAt=Date.now(); save(o); } }};
  var cs=document.currentScript;
  if(cs&&cs.hasAttribute('data-pill')){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mountPill); else mountPill(); }
})();
