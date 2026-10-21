storage "file" { path = "/vault/file" }
listener "tcp" { address = "0.0.0.0:8200" tls_disable = 1 }   # internal network only; Caddy never exposes it
ui = false
disable_mlock = false
