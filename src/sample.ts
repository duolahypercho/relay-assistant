import { completeChatStop } from '../shared/chat-stop.mjs';
import { prioritizeRuns } from '../shared/work-priority.mjs';
import { sampleSteeringRun } from '../shared/steering.mjs';
import { commitGroupRoute } from '../shared/groups.mjs';
import { api } from './api';
import { sampleRunReply, appendAssistant } from '../shared/assistant.mjs';
import { completeApproval, recordObservation } from '../shared/domain.mjs';
import { hasDueRoutines, dispatchRoutines, finishRoutine } from '../shared/routines.mjs';
import { calculateStep, commitStep } from '../shared/task-step.mjs';
let started = false,
  busy = false;
export function startSampleWorker() {
  if (started) return;
  started = true;
  setInterval(() => void tick(), 350);
}
async function tick() {
  if (busy || api.mode() !== 'sample') return;
  busy = true;
  try {
    if (api.snapshot().messages.some((m) => m.stopControl && m.stopControl.status !== 'completed'))
      await api.mutate((state) => {
        for (const message of state.messages)
          if (message.stopControl) completeChatStop(state, message.id);
      });
    if (hasDueRoutines(api.snapshot())) await api.mutate((s) => dispatchRoutines(s));
    let s = api.snapshot();
    const run =
      s.runs.find((r) => r.status === 'running') ||
      prioritizeRuns(s).find(
        (r: (typeof s.runs)[number]) =>
          r.status === 'queued' && !s.threads.find((t) => t.id === r.threadId)?.queuePaused,
      );
    if (run) {
      if (run.status === 'queued')
        await api.mutate((s) => {
          const r = s.runs.find((x) => x.id === run.id)!;
          r.status = 'running';
          r.startedAt = Date.now();
        });
      else if (Date.now() - run.startedAt > 900)
        await api.mutate((s) => {
          const r = s.runs.find((x) => x.id === run.id)!;
          if (r.status !== 'running') return;
          if (r.groupRouting) {
            commitGroupRoute(s, r.id, [r.groupMembers[0].id]);
            return;
          }
          const current = sampleSteeringRun(r);
          const m = s.messages.find((m) => m.id === current.messageId);
          const response = sampleRunReply(s, current);
          if (!r.routineId || finishRoutine(s, r, response))
            appendAssistant(
              s,
              r.threadId,
              response,
              r.routineId
                ? { routineId: r.routineId, routineTitle: r.routineTitle, routineRunId: r.id }
                : { replyTo: m!.id },
              r,
            );
          r.status = 'completed';
        });
    }
    s = api.snapshot();
    const a = s.approvals.find((a) => a.status === 'approved');
    if (a)
      await api.mutate((s) => {
        if (a.kind === 'terminal') {
          const c = a.payload.command;
          const out =
            c === 'pwd'
              ? '/workspace'
              : c === 'ls'
                ? s.files.map((f) => f.name).join('\n')
                : c === 'help'
                  ? 'Sample commands: pwd, ls, help.'
                  : 'This sample terminal supports pwd, ls and help. Configure the server for isolated commands.';
          completeApproval(s, a.id, {
            detail: 'Sample command completed.',
            stdout: out,
            command: c,
            exitCode: ['pwd', 'ls', 'help'].includes(c) ? 0 : 1,
          });
        } else
          completeApproval(s, a.id, {
            detail:
              a.kind === 'email'
                ? 'Reply saved in the sample Sent folder.'
                : 'Sample calendar updated.',
          });
      });
    s = api.snapshot();
    const task = s.tasks.find((t) => t.status === 'queued' || t.status === 'running');
    if (task) {
      if (task.status === 'queued')
        await api.mutate((s) => {
          const t = s.tasks.find((t) => t.id === task.id)!;
          t.status = 'running';
          t.startedStep = Date.now();
        });
      else if (Date.now() - task.startedStep > 650) {
        try {
          const step = await calculateStep(api.snapshot(), task);
          await api.mutate((s) => commitStep(s, task.id, step));
        } catch (e) {
          await api.mutate((s) => {
            const t = s.tasks.find((t) => t.id === task.id)!;
            if (t.status === 'running') {
              t.status = 'failed';
              t.error = (e as Error).message;
            }
          });
        }
      }
    }
    for (const w of api.snapshot().watches.filter((w) => !w.paused && w.nextCheck <= Date.now()))
      await api.mutate((s) =>
        recordObservation(
          s,
          w.id,
          w.url === 'relay://workshop' ? s.fixture.text : '',
          w.url === 'relay://workshop'
            ? ''
            : 'Public-page checks need the self-hosted server. The workshop test page works in this sample.',
        ),
      );
  } catch (e) {
    console.error('Sample worker:', e);
  } finally {
    busy = false;
  }
}
