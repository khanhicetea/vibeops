[{{slug}}]
user = {{uid}}
group = {{gid}}
listen = {{socketPath}}
listen.owner = {{uid}}
listen.group = 1500
listen.mode = 0660
pm = dynamic
pm.max_children = {{maxChildren}}
pm.start_servers = {{startServers}}
pm.min_spare_servers = {{minSpare}}
pm.max_spare_servers = {{maxSpare}}
php_admin_value[open_basedir] = {{openBasedir}}
php_admin_value[upload_tmp_dir] = {{home}}/tmp
php_admin_value[session.save_path] = {{home}}/tmp/sessions
slowlog = {{home}}/logs/php-slow.log
request_slowlog_timeout = 5s
catch_workers_output = yes
