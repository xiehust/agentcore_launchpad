import type { ReactNode } from "react";

export interface Column {
  key: string;
  label: ReactNode;
}

interface DataTableProps {
  columns: Column[];
  empty?: ReactNode;
  isEmpty?: boolean;
  children?: ReactNode;
}

export function DataTable({ columns, empty, isEmpty = false, children }: DataTableProps) {
  if (isEmpty && empty != null) {
    return (
      <div>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
        </table>
        <div className="empty">{empty}</div>
      </div>
    );
  }
  return (
    <table>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
