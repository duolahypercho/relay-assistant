import { useState, useRef } from 'react';
import {
  UploadSimple,
  DownloadSimple,
  ChartDonut,
  Target,
  ArrowUpRight,
  ArrowDownRight,
  MagnifyingGlass,
  FileCsv,
  Plus,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { summarizeTransactions, exampleCsv } from '../../shared/finance.mjs';
import { PageHeading, Field, Modal, Empty, money } from '../components/ui';
const colors = ['#173dca', '#5478e0', '#8aa3ef', '#bacaf6', '#64758f', '#acb5c6', '#dce2ed'];
export default function Finance() {
  const { s, act, run, go } = useWorkspace();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(0);
  const [importing, setImporting] = useState(false);
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('My transactions');
  const [goal, setGoal] = useState(false);
  const [goalTitle, setGoalTitle] = useState('Build a little breathing room');
  const [amount, setAmount] = useState('1000');
  const input = useRef<HTMLInputElement>(null);
  const totals = summarizeTransactions(s.transactions);
  const cats = Array.from(new Set(s.transactions.map((t) => t.category)));
  const filtered = s.transactions.filter(
    (t) =>
      (category === 'all' || t.category === category) &&
      t.description.toLowerCase().includes(query.toLowerCase()),
  );
  let cursor = 0;
  const stops = totals.categories.map((c: any, i: number) => {
    const start = cursor;
    cursor += c.percent;
    return `${colors[i % colors.length]} ${start}% ${cursor}%`;
  });
  async function upload(file?: File) {
    if (!file) return;
    await run(async () => {
      if (file.size > 2_000_000) throw new Error('Use a CSV smaller than 2 MB.');
      const text = await file.text();
      await act('finance.import', { csv: text, name: file.name });
    });
    if (input.current) input.current.value = '';
  }
  function downloadExample() {
    const url = URL.createObjectURL(new Blob([exampleCsv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'relay-example-transactions.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return (
    <section>
      <PageHeading
        title="Know where the month is going"
        description={
          s.transactions.length
            ? `${s.financeName} · ${totals.count} transactions · USD`
            : 'Bring your transactions, and make the patterns a little clearer.'
        }
      >
        <button className="secondary-button" onClick={() => setImporting(true)}>
          <FileCsv size={18} />
          Paste CSV
        </button>
        <button className="primary-button" onClick={() => input.current?.click()}>
          <UploadSimple size={18} />
          Import transactions
        </button>
        <input
          hidden
          type="file"
          accept=".csv,text/csv"
          ref={input}
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </PageHeading>
      {s.transactions.length ? (
        <>
          <div className="finance-metrics">
            <div className="metric">
              <span>
                <ArrowDownRight size={18} />
                Income
              </span>
              <strong>{money(totals.income)}</strong>
              <small>Positive transaction amounts</small>
            </div>
            <div className="metric">
              <span>
                <ArrowUpRight size={18} />
                Spending
              </span>
              <strong>{money(totals.expenses)}</strong>
              <small>Negative transaction amounts</small>
            </div>
            <div className="metric highlighted">
              <span>
                <Target size={18} />
                Remaining
              </span>
              <strong>{money(totals.net)}</strong>
              <small>Income less spending in this import</small>
            </div>
          </div>
          <div className="finance-overview">
            <div className="spending-chart">
              <div className="section-line">
                <h2>The shape of your spending</h2>
                <span>By category</span>
              </div>
              <div className="chart-content">
                <div
                  className="donut"
                  role="img"
                  aria-label={`Spending by category: ${totals.categories.map((c: any) => `${c.name} ${money(c.cents)}`).join(', ')}`}
                  style={{
                    background: stops.length ? `conic-gradient(${stops.join(',')})` : '#e6eaf3',
                  }}
                >
                  <div>
                    <small>Total spent</small>
                    <strong>{money(totals.expenses)}</strong>
                  </div>
                </div>
                <div className="chart-legend">
                  {totals.categories.map((c: any, i: number) => (
                    <button
                      key={c.name}
                      onClick={() => {
                        setCategory(c.name);
                        setPage(0);
                      }}
                    >
                      <span style={{ background: colors[i % colors.length] }} />
                      <div>
                        {c.name}
                        <small>{c.percent.toFixed(1)}%</small>
                      </div>
                      <strong>{money(c.cents)}</strong>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="finance-next-step">
              <span className="goal-card-icon">
                <Target size={25} />
              </span>
              <h2>Give what’s left a purpose.</h2>
              <p>A small, steady saving goal can make the next month feel a little easier.</p>
              <button className="secondary-button" onClick={() => setGoal(true)}>
                <Plus size={17} />
                Start a saving goal
              </button>
              <small>These totals cover this import, not all your accounts.</small>
            </div>
          </div>
          <div className="transactions-surface">
            <div className="surface-toolbar">
              <h2>Your transactions</h2>
              <div className="table-controls">
                <label className="search-input">
                  <MagnifyingGlass size={17} />
                  <input
                    aria-label="Search transactions"
                    placeholder="Find a transaction…"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(0);
                    }}
                  />
                </label>
                <select
                  aria-label="Filter category"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">All categories</option>
                  {cats.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th className="align-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(page * 10, page * 10 + 10).map((t) => (
                    <tr key={t.id}>
                      <td className="nowrap">{t.date}</td>
                      <td>{t.description}</td>
                      <td>
                        <select
                          className="category-select"
                          aria-label={`Category for ${t.description}`}
                          value={t.category}
                          onChange={(e) =>
                            void act('finance.category', { id: t.id, category: e.target.value })
                          }
                        >
                          {cats.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                          <option>Other</option>
                        </select>
                      </td>
                      <td className={`align-right nowrap ${t.cents > 0 ? 'positive-amount' : ''}`}>
                        {money(t.cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <p className="table-empty">No transactions match those filters.</p>
            )}
            <div className="table-pagination">
              <span>
                {filtered.length} transaction{filtered.length === 1 ? '' : 's'}
              </span>
              <div>
                <button
                  className="secondary-button"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </button>
                <span>
                  Page {page + 1} of {Math.max(1, Math.ceil(filtered.length / 10))}
                </span>
                <button
                  className="secondary-button"
                  disabled={(page + 1) * 10 >= filtered.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <Empty
          icon={ChartDonut}
          title="A clearer picture starts here"
          action={
            <button
              className="primary-button"
              onClick={() =>
                void act('finance.import', { csv: exampleCsv, name: 'Example transactions' })
              }
            >
              Try example transactions
            </button>
          }
        >
          Import a CSV with date, description, and amount columns. Expenses are negative; income is
          positive.
        </Empty>
      )}
      <div className="csv-help">
        <span>CSV format: date, description, amount, optional category.</span>
        <button className="text-button" onClick={downloadExample}>
          <DownloadSimple size={16} />
          Download example CSV
        </button>
      </div>
      {importing && (
        <Modal title="Bring your transactions" onClose={() => setImporting(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act('finance.import', { csv, name: filename })) setImporting(false);
            }}
          >
            <Field label="Import name">
              <input value={filename} onChange={(e) => setFilename(e.target.value)} required />
            </Field>
            <Field
              label="Transaction CSV"
              hint="Use YYYY-MM-DD dates. Negative amounts are expenses; positive amounts are income."
            >
              <textarea
                required
                rows={10}
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                placeholder={'date,description,amount\n2026-10-01,Coffee,-6.50'}
              />
            </Field>
            <button className="primary-button" type="submit">
              Import CSV
            </button>
          </form>
        </Modal>
      )}
      {goal && (
        <Modal title="A little more breathing room" onClose={() => setGoal(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await act('goal.create', {
                  title: goalTitle,
                  target: Number(amount),
                  unit: 'USD',
                  description: 'A saving goal built from your spending review.',
                  milestones: ['Choose a monthly saving amount', 'Review one recurring expense'],
                })
              ) {
                setGoal(false);
                go('goals');
              }
            }}
          >
            <Field label="Goal name">
              <input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} required />
            </Field>
            <Field label="Target amount (USD)">
              <input
                type="number"
                min="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </Field>
            <button className="primary-button" type="submit">
              Create saving goal
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
