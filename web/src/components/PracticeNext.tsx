import { useState } from "react";
import { bankLink, go } from "../lib/router";
import * as I from "./Icons";

/** "Would you like to practise questions previously asked at …?" Shown after an interview. */
export function PracticeNext({ company: initial = "", role: initialRole = "", compact = false }: { company?: string; role?: string; compact?: boolean }) {
  const [company, setCompany] = useState(initial);
  const [role, setRole] = useState(initialRole);
  const known = initial.trim().length > 1;

  return (
    <div className={`practice-next ${compact ? "compact" : ""}`}>
      <span className="pn-icon"><I.Target size={20} /></span>
      <div className="pn-body">
        <h3>{known ? `Practise questions previously asked at ${initial}?` : "Practise real questions from your target company?"}</h3>
        <p>
          Rehearsly searches Glassdoor, Reddit, LeetCode Discuss and more for questions candidates reported
          {known ? (initialRole ? ` for ${initialRole}` : "") : ""}, grouped by subject and date.
        </p>
        {!known && (
          <form
            className="pn-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (company.trim().length > 1) go(bankLink(company.trim(), role.trim()).slice(1));
            }}
          >
            <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" aria-label="Company" maxLength={80} />
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role (optional)" aria-label="Role" maxLength={80} />
            <button type="submit" className="primary" disabled={company.trim().length < 2}>Find questions</button>
          </form>
        )}
      </div>
      {known && (
        <a className="primary" href={bankLink(initial, initialRole)}>
          Show past questions
        </a>
      )}
    </div>
  );
}
