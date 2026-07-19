load_module /usr/lib/nginx/modules/ngx_http_acme_module.so;

worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
  worker_connections {{workerConnections}};
  multi_accept on;
}

http {
  resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;

  acme_shared_zone zone=ngx_acme_shared:10M;

  {{acmeIssuers}}

  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  sendfile on;
  keepalive_timeout 65;
  server_tokens off;
  client_max_body_size 64m;

  # Shared cache zones (cache data is kept on disk; keys use bounded shared memory).
  fastcgi_cache_path /var/cache/nginx/app_cache levels=1:2 keys_zone=app_cache:10m max_size=1g inactive=1d use_temp_path=off;
  proxy_cache_path /var/cache/nginx/proxy_assets levels=1:2 keys_zone=proxy_assets:20m max_size=2g inactive=7d use_temp_path=off;
  proxy_cache_path /var/cache/nginx/proxy_cache levels=1:2 keys_zone=proxy_cache:10m max_size=1g inactive=7d use_temp_path=off;

  log_format bento_timed '$remote_addr - $remote_user [$time_local] '
                         '"$request" $status $body_bytes_sent '
                         '"$http_referer" "$http_user_agent" '
                         'rt=$request_time urt=$upstream_response_time';

  gzip on;
  gzip_comp_level 5;
  gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

  # zstd enabled when modules present in image
  # zstd on;

  include /etc/nginx/sites/*.conf;
}
