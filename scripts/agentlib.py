"""Shared helpers for scripts/agent-msg and scripts/agent-inbox."""
import json, os, re, subprocess, sys

REPO = os.environ.get("ION_REPO", "monkylome/ION-Athens")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, ".git", "agent-inbox")
TRUSTED = {"OWNER", "COLLABORATOR", "MEMBER"}
MARKER = re.compile(r"^\s*<!-- agent-msg v1 from=(\S+) to=(\S+) kind=(\S+) -->")
LEGACY_TITLE = "[Agent question] "


def gh(*args, stdin=None):
    r = subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])} failed: {r.stderr.strip()}")
    return r.stdout


def login():
    os.makedirs(STATE, exist_ok=True)
    path = os.path.join(STATE, "login")
    if os.path.exists(path):
        return open(path).read().strip()
    name = gh("api", "user", "-q", ".login").strip()
    open(path, "w").write(name)
    return name


def me():
    """Agent identity, e.g. claude@nikolasgkou. Codex sets ION_AGENT=codex."""
    return f"{os.environ.get('ION_AGENT', 'claude')}@{login()}"


def marker(sender, to, kind):
    return f"<!-- agent-msg v1 from={sender} to={to} kind={kind} -->"


def parse(text):
    m = MARKER.match(text or "")
    return {"from": m.group(1), "to": m.group(2), "kind": m.group(3)} if m else None


QUERY = """query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
issues(first:50,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
number title state url closedAt body authorAssociation author{login}
assignees(first:5){nodes{login}} labels(first:10){nodes{name}}
comments(last:30){nodes{databaseId body authorAssociation author{login}}}}}}}"""


def threads():
    """Agent threads, each with its trusted messages in order."""
    owner, name = REPO.split("/")
    data = json.loads(gh("api", "graphql", "-f", f"query={QUERY}", "-f", f"owner={owner}", "-f", f"name={name}"))
    out = []
    for i in data["data"]["repository"]["issues"]["nodes"]:
        labels = [l["name"] for l in i["labels"]["nodes"]]
        if "agent-msg" not in labels and not i["title"].startswith(LEGACY_TITLE):
            continue
        raw = [{"id": f"issue-{i['number']}", **i}] + [{"id": str(c["databaseId"]), **c} for c in i["comments"]["nodes"]]
        msgs = []
        for m in raw:
            if m["authorAssociation"] not in TRUSTED or not m.get("author"):
                continue  # the repository is public: ignore everyone else
            author = m["author"]["login"]
            head = parse(m["body"]) or {"from": f"human@{author}", "to": "", "kind": "comment"}
            msgs.append({"id": m["id"], "author": author, "body": m["body"] or "", **head})
        if not msgs or msgs[0]["id"] != f"issue-{i['number']}":
            continue  # opened by someone we do not trust
        out.append({"number": i["number"], "title": i["title"], "open": i["state"] == "OPEN", "url": i["url"],
                    "labels": labels, "assignees": [a["login"] for a in i["assignees"]["nodes"]], "msgs": msgs})
    return out


def mine(msg, who=None):
    """True when a message was written by my side and is not addressed to me."""
    who = who or me()
    if msg["from"] == who:
        return True
    return msg["author"] == who.split("@")[1] and msg["to"] != who


def involves(thread, who=None):
    who = who or me()
    user = who.split("@")[1]
    root = thread["msgs"][0]
    if root["from"] == who:
        return True
    if root["to"]:
        return root["to"] in (who, user)
    return user in thread["assignees"]
