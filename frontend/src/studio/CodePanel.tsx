import { useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { type Node, type Edge } from '@xyflow/react';
import { Code, Download, Copy, AlertCircle } from 'lucide-react';
import { Btn } from '../components';
import { generateStrandsAgentCode } from './lib/code-generator';

interface CodePanelProps {
  nodes: Node[];
  edges: Edge[];
  graphMode?: boolean;
  className?: string;
}

export function CodePanel({ nodes, edges, graphMode = false, className = '' }: CodePanelProps) {
  const [copied, setCopied] = useState(false);

  const { code, errors } = useMemo(() => {
    const result = generateStrandsAgentCode(nodes, edges, graphMode);
    return {
      code: result.imports.join('\n') + '\n\n' + result.code,
      errors: result.errors,
    };
  }, [nodes, edges, graphMode]);

  const handleDownload = () => {
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'strands_agent.py';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard unavailable — ignore */
      },
    );
  };

  return (
    <div className={`studio-codepanel ${className}`}>
      <div className="studio-code-head">
        <Code size={14} style={{ color: 'var(--amber)' }} />
        <h3>Generated code</h3>
        <div className="studio-code-actions">
          <Btn onClick={handleCopy}>
            <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
          </Btn>
          <Btn onClick={handleDownload}>
            <Download size={12} /> Download
          </Btn>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="studio-code-errs">
          <div className="studio-code-errs-h">
            <AlertCircle size={12} /> CODE GENERATION ERRORS
          </div>
          <ul>
            {errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="studio-code-monaco">
        <Editor
          height="100%"
          language="python"
          theme="vs-dark"
          value={code}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            lineNumbers: 'on',
            roundedSelection: false,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: 'on',
            readOnly: true,
          }}
        />
      </div>

      <div className="studio-code-foot">
        <span>Python • Strands Agent SDK</span>
        <span>{code.split('\n').length} lines</span>
      </div>
    </div>
  );
}
