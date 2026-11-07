/* Same · service worker: shows the "ready" alert and opens the order when tapped */
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function(e){
  var d={}; try{ d=e.data?e.data.json():{}; }catch(err){ d={body:e.data?e.data.text():''}; }
  e.waitUntil(self.registration.showNotification(d.title||'Same', { body:d.body||'Your photos are ready.', icon:'icon.png', badge:'icon.png', data:{url:d.url||'ready.html'}, vibrate:[80,40,80] }));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url=(e.notification.data&&e.notification.data.url)||'ready.html';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
    for(var i=0;i<list.length;i++){ if(list[i].url.indexOf('ready.html')>=0&&'focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
