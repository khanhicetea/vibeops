worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
  worker_connections {{workerConnections}};
  multi_accept on;
}

http {
  map $http_x_forwarded_proto $fastcgi_https {
    default '';
    https 'on';
  }

  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  sendfile on;
  keepalive_timeout 65;
  server_tokens off;
  client_max_body_size 64m;

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
