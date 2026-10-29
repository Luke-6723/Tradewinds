"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, Loading, NativeSelect, PageHeader, Panel, TextArea } from "@/components/kibb/bits";
import { LoadMore, useNextCursorPaged } from "@/components/kibb/company-paged";
import { WarnBox, firstProblem } from "@/components/kibb/finance-common";
import { useOurCompanyNames } from "@/components/kibb/naval-common";
import { Field } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { usePoll } from "@/hooks/use-poll";
import { DashboardApiError, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtAgo, fmtDateTime } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile } from "@/lib/kibb/types";

/** Guide 3.21: per company and real hour at most 10 posts, 3 of them new threads; edit or delete for 10 real minutes. */
const LIMIT = { postsPerHour: 10, threadsPerHour: 3, titleMax: 120, bodyMax: 1_000, flagMax: 200, editMinutes: 10 } as const;

const EXCHANGE_KINDS: Array<{ kind: S.ExchangeKind; label: string }> = [
  { kind: "ship_for_sale", label: "Ship for sale" },
  { kind: "commission", label: "Commission" },
  { kind: "venture", label: "Venture" },
  { kind: "ship_shares", label: "Ship shares" },
  { kind: "licence_offer", label: "Licence offer" },
  { kind: "licence_request", label: "Licence request" },
  { kind: "loan_request", label: "Loan request" },
  { kind: "bank", label: "Bank" },
  { kind: "futures", label: "Futures" },
];

/** A bulletin write, with the hourly limit and the ten-minute window said plainly. */
async function bulletinPost<T>(path: string, body: unknown): Promise<T> {
  try {
    return await kibbPost<T>(path, body);
  } catch (e) {
    if (e instanceof DashboardApiError && e.status === 429 && e.code === "bulletin_limit") {
      throw new Error(
        `The bulletin's hourly limit is reached: at most ${LIMIT.postsPerHour} posts a real hour per company, ${LIMIT.threadsPerHour} of them new threads (deleted posts count). ${e.detail}`,
      );
    }
    if (e instanceof DashboardApiError && e.status === 409 && (path.endsWith("/edit") || path.endsWith("/delete"))) {
      throw new Error(`Too late: a post can be edited or deleted only for ${LIMIT.editMinutes} real minutes after posting; after that it is permanent. ${e.detail}`);
    }
    throw e;
  }
}

/** The clock, ticking every second while `active` (edit-window countdowns). */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** "about Hanse & Co", "about an Exchange venture": a thread's link in a few words. */
function linkLabel(link: S.BulletinLink): string {
  if (link.type === "company") return `about ${link.name}`;
  return `about an Exchange ${EXCHANGE_KINDS.find((k) => k.kind === link.kind)?.label.toLowerCase() ?? "entry"}`;
}

function LinkText({ link }: { link: S.BulletinLink | null | undefined }) {
  if (!link) return null;
  if (link.type === "company") return <span>about {link.name}</span>;
  const label = EXCHANGE_KINDS.find((k) => k.kind === link.kind)?.label ?? link.kind;
  return (
    <span>
      about a{/^[aeiou]/i.test(label) ? "n" : ""}{" "}
      <Link href="/exchange" className="text-primary hover:underline">
        {label.toLowerCase()}
      </Link>{" "}
      on the Exchange <span className="font-mono">{link.id.slice(0, 8)}</span>
    </span>
  );
}

// ── A post and its controls ───────────────────────────────────────────────────

function PostView({
  post,
  thread,
  mine,
  sibling,
  now,
  onDone,
}: {
  post: S.BulletinPost;
  thread: S.BulletinThread;
  /** Posted by the active company: it may edit or delete within the window. */
  mine: boolean;
  /** Posted by another company of our player. */
  sibling: boolean;
  now: number;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "flag">("view");
  const [body, setBody] = useState(post.body);
  const [title, setTitle] = useState(thread.title);
  const [reason, setReason] = useState("");
  const done = () => {
    setMode("view");
    onDone();
  };
  // Resolves to null when a confirmation is declined.
  const act = useAction<S.BulletinPost | S.FlagResult | null>((r) => r && done());
  const gone = post.deleted || post.removed;
  const left = Date.parse(post.editable_until) - now;
  const editable = mine && !gone && left > 0;
  const editWhy = firstProblem([
    [body.trim().length > 0, "The post can't be empty."],
    [body.trim().length <= LIMIT.bodyMax, `At most ${LIMIT.bodyMax.toLocaleString("en-GB")} characters (${body.trim().length} now).`],
    [!post.is_opening || (title.trim().length > 0 && title.trim().length <= LIMIT.titleMax), `The title takes 1 to ${LIMIT.titleMax} characters.`],
  ]);
  const flagWhy = firstProblem([
    [reason.trim().length > 0, "Say why the harbourmaster should look at it."],
    [reason.trim().length <= LIMIT.flagMax, `At most ${LIMIT.flagMax} characters.`],
  ]);

  function save() {
    void act.run(() =>
      bulletinPost<S.BulletinPost>("/v1/bulletin/edit", {
        post_id: post.id,
        body: body.trim(),
        ...(post.is_opening && title.trim() !== thread.title ? { title: title.trim() } : {}),
      }),
    );
  }

  function remove() {
    void act.run(async () => {
      if (!confirm(`Delete this post? It keeps its place in the thread as "deleted by its author", and it still counts toward your ${LIMIT.postsPerHour} posts an hour.`)) return null;
      return bulletinPost<S.BulletinPost>("/v1/bulletin/delete", { post_id: post.id });
    });
  }

  function flag() {
    void act.run(async () => {
      if (!confirm(`Flag ${post.company_name}'s post for the harbourmaster? It is looked at by hand; a company may flag a post once.`)) return null;
      return bulletinPost<S.FlagResult>("/v1/bulletin/flag", { post_id: post.id, reason: reason.trim() });
    });
  }

  return (
    <li className="border-b py-3 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        <span className="font-medium text-foreground text-sm">{post.company_name}</span>
        {mine && <Badge variant="info" size="sm">you</Badge>}
        {sibling && <Badge variant="secondary" size="sm">your company</Badge>}
        {post.is_opening && <Badge variant="outline" size="sm">opening post</Badge>}
        <span className="text-muted-foreground" title={fmtDateTime(post.created_at)}>
          {fmtAgo(post.created_at)}
        </span>
        {post.edited_at && <span className="text-muted-foreground">edited {fmtAgo(post.edited_at)}</span>}
        {editable && <span className="text-muted-foreground">editable for {mmss(left)}</span>}
      </div>
      {mode === "edit" && editable ? (
        <div className="mt-2 space-y-2">
          {post.is_opening && <Input value={title} maxLength={LIMIT.titleMax} onChange={(e) => setTitle(e.target.value)} placeholder="Thread title" />}
          <TextArea value={body} rows={4} onChange={(e) => setBody(e.target.value)} />
          <ErrorNote error={act.error ?? editWhy} />
          <div className="flex gap-2">
            <Button size="sm" disabled={!!editWhy || act.busy} onClick={save}>
              {act.busy ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className={`mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere] ${gone ? "text-muted-foreground italic" : ""}`}>{post.body}</p>
      )}
      {mode === "flag" && (
        <div className="mt-2 space-y-2">
          <Input value={reason} maxLength={LIMIT.flagMax} onChange={(e) => setReason(e.target.value)} placeholder="Why the harbourmaster should look at it" />
          <ErrorNote error={act.error ?? (reason ? flagWhy : null)} />
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={!!flagWhy || act.busy} onClick={flag}>
              {act.busy ? "Flagging…" : "Flag"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {mode === "view" && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {editable && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBody(post.body);
                  setTitle(thread.title);
                  setMode("edit");
                }}
              >
                Edit
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" disabled={act.busy} onClick={remove}>
                Delete
              </Button>
            </>
          )}
          {!mine && !gone && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setMode("flag")}>
              Flag
            </Button>
          )}
        </div>
      )}
      {mode === "view" && <ErrorNote error={act.error} className="mt-1.5" />}
      {act.result && "flagged_at" in act.result && <p className="mt-1 text-muted-foreground text-xs">Flagged for the harbourmaster.</p>}
    </li>
  );
}

// ── A thread ──────────────────────────────────────────────────────────────────

function ThreadView({ threadId, companyName, ourNames, onChanged }: { threadId: string; companyName: string | undefined; ourNames: Set<string>; onChanged: () => void }) {
  const { data, error, reload } = usePoll(() => kibbGet<S.BulletinThreadDetail>("/v1/bulletin/thread", { id: threadId }), 20_000, [threadId]);
  const [reply, setReply] = useState("");
  const act = useAction<S.BulletinPost>(() => {
    setReply("");
    void reload();
    onChanged();
  });
  const detail = data?.thread.id === threadId ? data : undefined;
  const anyEditable = !!detail?.posts.some((p) => p.company_name === companyName && !p.deleted && !p.removed && Date.parse(p.editable_until) > Date.now());
  const now = useNow(anyEditable);
  if (!detail) return error ? <ErrorNote error={error} /> : <Loading />;
  const t = detail.thread;
  const closed = t.archived || t.removed;
  const text = reply.trim();
  const why = firstProblem([
    [!closed, t.removed ? "The harbourmaster took this thread down: it is closed to replies." : "Archived (no post for three real days): closed to replies. Open a new thread."],
    [text.length > 0, "Write a reply."],
    [text.length <= LIMIT.bodyMax, `At most ${LIMIT.bodyMax.toLocaleString("en-GB")} characters (${text.length} now).`],
  ]);

  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={`font-semibold ${t.removed ? "text-muted-foreground italic" : ""}`}>{t.title}</h3>
          {t.archived && <Badge variant="secondary" size="sm">archived</Badge>}
          {t.removed && <Badge variant="error" size="sm">removed</Badge>}
        </div>
        <p className="text-muted-foreground text-xs">
          Opened by {t.company_name} {fmtAgo(t.created_at)} · {t.replies} repl{t.replies === 1 ? "y" : "ies"} · last post {fmtAgo(t.last_post_at)}{" "}
          {t.link && (
            <>
              · <LinkText link={t.link} />
            </>
          )}
        </p>
      </div>
      <ul>
        {detail.posts.map((p) => (
          <PostView
            key={`${p.id}:${p.edited_at ?? ""}:${p.deleted}`}
            post={p}
            thread={t}
            mine={!!companyName && p.company_name === companyName}
            sibling={p.company_name !== companyName && ourNames.has(p.company_name)}
            now={now}
            onDone={() => {
              void reload();
              onChanged();
            }}
          />
        ))}
      </ul>
      {closed ? (
        <p className="text-muted-foreground text-sm">{why}</p>
      ) : (
        <div className="space-y-2 border-t pt-3">
          <TextArea value={reply} rows={3} onChange={(e) => setReply(e.target.value)} placeholder={`Reply as ${companyName ?? "your company"}`} />
          <p className={`text-xs ${text.length > LIMIT.bodyMax ? "text-destructive" : "text-muted-foreground"}`}>
            {text.length} / {LIMIT.bodyMax.toLocaleString("en-GB")} characters · signed {companyName ?? "with your company's name"}
          </p>
          <ErrorNote error={act.error ?? (reply ? why : null)} />
          <Button size="sm" disabled={!!why || act.busy} onClick={() => void act.run(() => bulletinPost<S.BulletinPost>("/v1/bulletin/reply", { thread_id: t.id, body: text }))}>
            {act.busy ? "Posting…" : "Reply"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Opening a thread ──────────────────────────────────────────────────────────

function NewThread({ companyName, onOpened }: { companyName: string | undefined; onOpened: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [linkType, setLinkType] = useState<"" | "exchange" | "company">("");
  const [linkKind, setLinkKind] = useState<S.ExchangeKind>("ship_for_sale");
  const [linkId, setLinkId] = useState("");
  const [linkName, setLinkName] = useState("");
  const act = useAction<S.BulletinThreadDetail>((r) => {
    setTitle("");
    setBody("");
    setLinkType("");
    setLinkId("");
    setLinkName("");
    onOpened(r.thread.id);
  });
  const ttl = title.trim();
  const text = body.trim();
  const why = firstProblem([
    [ttl.length > 0 && ttl.length <= LIMIT.titleMax, `The title takes 1 to ${LIMIT.titleMax} characters.`],
    [text.length > 0, "Write the opening post."],
    [text.length <= LIMIT.bodyMax, `The post takes at most ${LIMIT.bodyMax.toLocaleString("en-GB")} characters (${text.length} now).`],
    [linkType !== "exchange" || linkId.trim().length > 0, "Enter the Exchange entry's id (its offer's own id; a bank's is its company id)."],
    [linkType !== "company" || linkName.trim().length > 0, "Enter the company's name."],
  ]);
  const link: S.BulletinLink | undefined =
    linkType === "exchange" ? { type: "exchange", kind: linkKind, id: linkId.trim() } : linkType === "company" ? { type: "company", name: linkName.trim() } : undefined;

  function submit() {
    if (!confirm(`Open the thread "${ttl}", signed ${companyName ?? "with your company's name"}? It counts as one of your ${LIMIT.threadsPerHour} new threads this hour, and you can edit or delete it for ${LIMIT.editMinutes} minutes.`)) return;
    void act.run(() => bulletinPost<S.BulletinThreadDetail>("/v1/bulletin/thread", { title: ttl, body: text, ...(link ? { link } : {}) }));
  }

  return (
    <div className="space-y-3">
      <Field label="Title">
        <Input value={title} maxLength={LIMIT.titleMax} onChange={(e) => setTitle(e.target.value)} placeholder="What the thread is about" />
      </Field>
      <Field label="Opening post">
        <TextArea value={body} rows={5} onChange={(e) => setBody(e.target.value)} placeholder="Numbers are welcome here." />
      </Field>
      <p className={`text-xs ${text.length > LIMIT.bodyMax ? "text-destructive" : "text-muted-foreground"}`}>
        {text.length} / {LIMIT.bodyMax.toLocaleString("en-GB")} characters
      </p>
      <Field label="About (optional)">
        <NativeSelect value={linkType} onChange={(e) => setLinkType(e.target.value as "" | "exchange" | "company")}>
          <option value="">Nothing in particular</option>
          <option value="exchange">An open Exchange entry</option>
          <option value="company">A company</option>
        </NativeSelect>
      </Field>
      {linkType === "exchange" && (
        <div className="grid grid-cols-2 gap-3">
          <NativeSelect value={linkKind} onChange={(e) => setLinkKind(e.target.value as S.ExchangeKind)}>
            {EXCHANGE_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </NativeSelect>
          <Input value={linkId} onChange={(e) => setLinkId(e.target.value)} placeholder="entry id" />
        </div>
      )}
      {linkType === "company" && <Input value={linkName} onChange={(e) => setLinkName(e.target.value)} placeholder="Exact company name" />}
      <ErrorNote error={act.error ?? (title || body ? why : null)} />
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Opening…" : "Open the thread"}
      </Button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BulletinPage() {
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const companyName = profile?.company.name;
  const ourNames = useOurCompanyNames(companyName);
  const [selected, setSelected] = useState<string | null>(null);
  const threads = useNextCursorPaged<S.BulletinPage, S.BulletinThread>(
    (cursor) => kibbGet<S.BulletinPage>("/v1/bulletin", { cursor, limit: 30 }),
    (p) => p.threads,
    [],
  );

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Bulletin"
        subtitle="Public deal talk: threads and replies, every post signed with its company's name. There are no private messages, and nothing agreed here is enforced."
        actions={
          <Button variant="outline" disabled={threads.loading} onClick={threads.reload}>
            Refresh
          </Button>
        }
      />
      <div className="grid items-start gap-4 xl:grid-cols-5">
        <Panel title="Threads (most recently active first)" className="xl:col-span-2">
          <ErrorNote error={threads.error} />
          {threads.items.length === 0 ? (
            threads.loading ? <Loading /> : <Empty>No threads yet.</Empty>
          ) : (
            <ul>
              {threads.items.map((t) => (
                <li key={t.id} className="border-b last:border-0">
                  <button
                    type="button"
                    onClick={() => setSelected(t.id)}
                    className={`w-full rounded-md px-2 py-2 text-left hover:bg-accent ${selected === t.id ? "bg-accent" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`font-medium text-sm ${t.removed ? "text-muted-foreground italic" : ""}`}>{t.title}</span>
                      {t.archived && <Badge variant="secondary" size="sm">archived</Badge>}
                      {t.removed && <Badge variant="error" size="sm">removed</Badge>}
                      {t.company_name === companyName && <Badge variant="info" size="sm">yours</Badge>}
                    </div>
                    <div className="mt-0.5 text-muted-foreground text-xs">
                      {t.company_name} · {t.replies} repl{t.replies === 1 ? "y" : "ies"} · active {fmtAgo(t.last_post_at)}
                      {t.link && <> · {linkLabel(t.link)}</>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <LoadMore loading={threads.loading} done={threads.done} onClick={threads.loadMore} count={threads.items.length} />
        </Panel>
        <div className="space-y-4 xl:col-span-3">
          {selected && (
            <Panel
              title="Thread"
              action={
                <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                  Close
                </Button>
              }
            >
              <ThreadView key={selected} threadId={selected} companyName={companyName} ourNames={ourNames} onChanged={threads.reload} />
            </Panel>
          )}
          <Panel title="Open a thread">
            <NewThread
              companyName={companyName}
              onOpened={(id) => {
                threads.reload();
                setSelected(id);
              }}
            />
          </Panel>
          <WarnBox tone="info">
            <p>
              Each company may post at most {LIMIT.postsPerHour} times a real hour, and at most {LIMIT.threadsPerHour} of those may open a thread; deleted posts still
              count. A post can be edited or deleted for {LIMIT.editMinutes} real minutes, then it is permanent; a deleted one keeps its place as &quot;deleted by its
              author&quot;.
            </p>
            <p>
              A thread with no new post for three real days is archived: still readable, closed to replies. Flag a post to ask the harbourmaster to look at it (once
              per post, never your own); a post taken down reads &quot;removed by the harbourmaster&quot;, and a company may be muted from posting for a while.
            </p>
            <p>
              A deal agreed here is a gentlemen&apos;s agreement: carry it out through the ordinary pages (list the ship at the agreed price, quote the agreed rate). Check a
              partner&apos;s record first on the{" "}
              <Link href="/loans" className="underline">
                loans
              </Link>{" "}
              page.
            </p>
          </WarnBox>
        </div>
      </div>
    </div>
  );
}
