# Deploying on AWS EC2

One EC2 instance running the same `docker compose` stack as on a laptop:
nginx on port 80 in front of the API. No load balancer, no database, nothing
paid besides the instance. About 30 minutes the first time.

```
Reviewer's browser ──HTTP :80──▶ EC2 [ nginx gateway ──▶ urja-api ] ──HTTPS──▶ Urja portal
```

## 0. What you need

- An AWS account and a public GitHub repository with this code (step 1).
- Your portal credentials and API keys. They go only into a `.env` file on the
  server, never into git.

### Instance size

The API uses about 60 to 100 MB of memory at runtime (403 meters, bounded
caches). The heaviest moment is `docker compose up --build`, when `npm ci` and
the TypeScript compiler run.

| Instance | RAM | Verdict |
|---|---|---|
| t3.micro / t2.micro (free tier) | 1 GB | Works with the 2 GB swap the setup script adds, but the build is slow |
| **t3.small** | 2 GB | **Recommended**: plenty for build and runtime |
| t3.medium | 4 GB | More than enough; fine if you already planned it, not needed |

Use **Ubuntu Server 24.04 LTS**, 20 GB gp3 disk. Pick a region near you (for
India, `ap-south-1` Mumbai). Check current prices on the EC2 pricing page and
**stop the instance when the review is over**.

## 1. Put the code on GitHub (from your Windows PC)

Create an empty **public** repository on github.com (no README, no
.gitignore; the repo already has them), e.g. `urja-api`. Then in Git Bash, in
the project folder:

```bash
git init -b main
git add .
git status                       # check: no .env, no fixtures/local, no node_modules, no dist
git check-ignore -v .env         # must print the .gitignore rule; if it prints nothing, STOP
git commit -m "Urja API: clean REST API over the Urja Meter Ops portal"
git remote add origin https://github.com/<you>/urja-api.git
git push -u origin main
```

On GitHub, open the **Actions** tab: the CI run (typecheck, 231 tests, build,
Docker build) should go green within a few minutes.

## 2. Launch the instance (AWS console)

EC2 → **Launch instance**:

1. Name `urja-api`, image **Ubuntu Server 24.04 LTS (64-bit x86)**.
2. Instance type **t3.small** (or t3.medium).
3. Key pair: create one (`urja-key`, type RSA, format `.pem`) and keep the
   file safe. It is the only way to log in.
4. Network settings → **Create security group** with exactly these inbound
   rules:

   | Type | Port | Source | Why |
   |---|---|---|---|
   | SSH | 22 | **My IP** | only you can log in |
   | HTTP | 80 | Anywhere (0.0.0.0/0) | reviewers reach nginx |

   Do not open 3000: the API is only reachable through nginx.
5. Storage: 20 GB gp3. Launch.
6. Optional but useful: **Elastic IPs → Allocate → Associate** with the
   instance, so the address does not change if you stop and start it.

Note the instance's **Public IPv4 address** (`<EC2_IP>` below).

## 3. Log in and install Docker

From Git Bash or PowerShell on your PC:

```bash
ssh -i path/to/urja-key.pem ubuntu@<EC2_IP>
```

(If Windows complains the key's permissions are too open, use Git Bash and
run `chmod 400 urja-key.pem` first.)

On the server:

```bash
git clone https://github.com/<you>/urja-api.git
cd urja-api
bash deploy/ec2-setup.sh     # Docker + Compose plugin, 2 GB swap, portal reachability check
exit                         # log out once so the docker group applies
```

Log back in with the same `ssh` command.

## 4. Configure secrets on the server

```bash
cd urja-api
cp .env.example .env
openssl rand -base64 24 | tr '+/' '-_'      # run twice: one key for you, one for the reviewer
nano .env
```

Set at least:

```bash
PORTAL_EMAIL=<portal account from the brief>
PORTAL_PASSWORD=<portal password>
API_KEYS=sameer:<first key>,tester:uKmXzDqwVrlosCHMOThjrkJeeILTQop6
```

`tester` is the reviewer key published in the README, so a reviewer can use the
same key locally and here. Remove it from `API_KEYS` after the review.

Leave `TRUST_PROXY` alone (Compose sets it to 1 for nginx). Set
`CORS_ORIGINS` only if a browser app on another domain will call the API.
Save (Ctrl+O, Enter, Ctrl+X), then:

```bash
chmod 600 .env               # only your user can read it
```

## 5. Start it

```bash
docker compose up -d --build     # first build takes a few minutes on t3.small
docker compose ps                # api: Up (healthy), gateway: Up
curl -s localhost/health         # {"status":"ok",...}
curl -s localhost/ready          # "ready":true once the catalog has loaded (a few seconds)
docker compose logs -f api       # Ctrl+C to stop following
```

From your PC's browser: `http://<EC2_IP>/docs` → **Authorize** → paste a key
→ try `GET /v1/meters`. Or:

```bash
curl -H "X-API-Key: <reviewer key>" "http://<EC2_IP>/v1/meters?status=faulty&limit=2"
```

The containers restart on their own after a crash or a reboot
(`restart: unless-stopped`, and Docker starts at boot).

## 6. Give the reviewer access

Send them, privately (email, not the public repo):

- the URL `http://<EC2_IP>/docs`
- the `reviewer` key

Each consumer has its own named key, so the reviewer's requests show up as
`consumer: "reviewer"` in the logs and you can revoke it without touching
yours: remove it from `API_KEYS`, then `docker compose up -d --force-recreate api`.

## 7. Day-to-day

| Task | Command (in `~/urja-api`) |
|---|---|
| Deploy a new version | `git push` (with 7a set up), or on the server `bash deploy/deploy.sh` |
| Change `.env` | edit, then `docker compose up -d --force-recreate api` |
| Logs | `docker compose logs --tail 100 api` (JSON, one line per request) |
| Status and memory | `docker compose ps`, `docker stats --no-stream` |
| Stop / start | `docker compose down` / `docker compose up -d` |
| Free disk from old images | `docker image prune -f` |

Stopping the EC2 instance in the console stops the billing for compute (the
disk is still billed, a few cents a month). **Terminate** it when you are
completely done.

## 7a. Deploy automatically on push (GitHub Actions)

After this, `git push` to `main` is the whole deploy: CI runs the tests, and
only if they pass, a second workflow SSHes into the instance and runs
`deploy/deploy.sh` (`git pull --ff-only`, `docker compose up -d --build`,
wait for `/ready`, print `/health`). A failed deploy shows red in the
Actions tab with the API's last log lines.

```
git push ──▶ CI (typecheck, tests, build, docker) ──green──▶ Deploy ──ssh──▶ EC2: deploy/deploy.sh
```

**1. A deploy key that can only deploy** (on the server):

```bash
ssh-keygen -t ed25519 -f ~/gh_deploy -N "" -C github-deploy
# Lock the key to the deploy script: it cannot open a shell or run anything else.
echo "command=\"bash /home/ubuntu/urja-api/deploy/deploy.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat ~/gh_deploy.pub)" >> ~/.ssh/authorized_keys
cat ~/gh_deploy        # copy the whole PRIVATE key (BEGIN ... END lines included)
rm ~/gh_deploy ~/gh_deploy.pub
```

**2. Secrets on GitHub:** repo → Settings → Secrets and variables → Actions →
New repository secret, three times:

| Name | Value |
|---|---|
| `EC2_HOST` | the instance's public IP, e.g. `15.252.70.41` (use an Elastic IP so it does not change) |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | the private key from step 1 |

**3. The workflow:** move `deploy/deploy.yml` to `.github/workflows/deploy.yml`,
commit and push.

**4. Let GitHub reach SSH.** GitHub's runners connect from changing IP
addresses, so "SSH from My IP" blocks them. For this review setup, change the
SSH rule in the security group to `0.0.0.0/0`. That is acceptable here because
Ubuntu on EC2 only accepts key logins (no passwords), your own key and the
locked deploy key are the only keys, and the deploy key can run nothing but
the deploy script. A stricter alternative is a self-hosted runner on the
instance (no inbound SSH at all), or having the workflow add its own IP to the
security group for the duration of the job with AWS credentials; both are more
setup than this assignment needs.

Test it: Actions tab → Deploy → **Run workflow**, or push any commit to
`main`. Never edit tracked files on the server: `git pull --ff-only` then
refuses and the deploy fails (on purpose, instead of overwriting the edit).
`.env` is untracked and is never touched.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Browser can't reach `http://<EC2_IP>` | Security group has HTTP 80 from 0.0.0.0/0; `docker compose ps` shows the gateway Up; you used `http://`, not `https://` |
| `/ready` stays 503 | `docker compose logs api`: a `catalog.refresh_failed` with a login error means wrong credentials in `.env`; "could not reach" means the portal is unreachable from AWS (`curl -I https://urja-ops.flockenergy.tech` on the server). The service retries on its own (30 s, 60 s, ... 5 min) |
| `401` on every `/v1` call | Send the key part only (after `name:`), as `X-API-Key` or `Authorization: Bearer` |
| `429` | nginx allows 20 requests/s per IP (burst 40), the API 300/min per key |
| Build killed / very slow | Not enough memory: check `free -h` shows the swap; use t3.small |
| `permission denied ... docker.sock` | You did not log out and back in after the setup script |
| `ssh: connection timed out` | Your IP changed: update the SSH rule to "My IP" again |

## 9. HTTPS (optional, needs a domain; not tested in this repo)

Plain HTTP is fine for a review, but API keys travel unencrypted. With a
domain pointing at the Elastic IP, the simplest route is to open port 443 in
the security group and get a certificate with certbot on the host, then add a
`listen 443 ssl` server block to `deploy/nginx.conf` with the certificate
mounted into the gateway container. An alternative is putting an AWS
Application Load Balancer with an ACM certificate in front. Both are outside
what this assignment needs, so they are described, not scripted.

## Security checklist

- [ ] `.env` is not in git (`git check-ignore -v .env` prints a rule) and is `chmod 600` on the server
- [ ] SSH (22) is open to your IP only (or to 0.0.0.0/0 with key-only login and the locked deploy key, see 7a); port 3000 is not open at all
- [ ] Reviewer has their own key, sent privately
- [ ] The API container runs as a non-root user on a read-only filesystem (`docker compose exec api id`)
- [ ] The instance is stopped or terminated after the review
