/**
 * Launchpad-specific addition (see LICENSE): deploy the generated flow through
 * the Launchpad platform's unified pipeline instead of studio's direct path.
 */
import { useRef, useState } from 'react';
import { Rocket } from 'lucide-react';
import {
  deployToLaunchpad,
  getLaunchpadAgent,
  getLaunchpadJob,
  type LaunchpadJobEvent,
} from '../lib/launchpad-client';

interface Props {
  getCode: () => string;
}

export function LaunchpadDeploySection({ getCode }: Props) {
  const [agentName, setAgentName] = useState('studio-agent');
  const [status, setStatus] = useState<'idle' | 'deploying' | 'active' | 'failed'>('idle');
  const [events, setEvents] = useState<LaunchpadJobEvent[]>([]);
  const [arn, setArn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const deploy = async () => {
    const code = getCode();
    if (!code.trim()) {
      setError('Generate code first (add nodes to the canvas).');
      return;
    }
    setStatus('deploying');
    setError(null);
    setEvents([]);
    try {
      const result = await deployToLaunchpad(agentName, code);
      const poll = async () => {
        const [agent, job] = await Promise.all([
          getLaunchpadAgent(result.agent.id),
          getLaunchpadJob(result.job_id),
        ]);
        setEvents(job.events ?? []);
        if (agent.status === 'active') {
          setStatus('active');
          setArn(agent.arn);
          return;
        }
        if (agent.status === 'failed') {
          setStatus('failed');
          setError(job.events?.slice(-1)[0]?.msg ?? 'deployment failed');
          return;
        }
        timer.current = window.setTimeout(poll, 4000);
      };
      void poll();
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="p-4 border-b border-amber-300 bg-amber-50">
      <div className="flex items-center justify-between">
        <div className="flex items-center">
          <Rocket className="w-4 h-4 text-amber-600 mr-2" />
          <span className="text-sm font-semibold text-gray-900">
            Deploy via Launchpad platform
          </span>
          <span className="ml-2 text-xs text-gray-500">
            unified pipeline · ledger · registry
          </span>
        </div>
        <div className="flex items-center space-x-2">
          <input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            className="px-2 py-1 text-sm border border-gray-300 rounded w-44"
            placeholder="agent-name"
          />
          <button
            onClick={() => void deploy()}
            disabled={status === 'deploying'}
            className="px-3 py-1 text-sm rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {status === 'deploying' ? 'Deploying…' : 'Deploy'}
          </button>
        </div>
      </div>
      {status !== 'idle' && (
        <div className="mt-2 text-xs font-mono">
          <div
            className={
              status === 'active'
                ? 'text-green-700'
                : status === 'failed'
                  ? 'text-red-700'
                  : 'text-gray-700'
            }
          >
            status: {status}
            {arn ? ` · ${arn}` : ''}
          </div>
          {error && <div className="text-red-700">{error}</div>}
          <div className="max-h-24 overflow-y-auto mt-1 text-gray-600">
            {events.slice(-6).map((event, index) => (
              <div key={index}>
                {event.ts.slice(11, 19)} [{event.stage}] {event.msg.slice(0, 90)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
