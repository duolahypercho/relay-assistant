// SPDX-License-Identifier: MIT
// CSV parsing and money calculations are shared by the sample and server runtimes.
export function parseCsv(text) {
  if (typeof text !== 'string' || text.length > 2_000_000)
    throw new Error('Use a CSV smaller than 2 MB.');
  const rows = [];
  let row = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell.trim() !== '')
        throw new Error('A quotation mark appears inside an unquoted value.');
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell.trim());
      cell = '';
      if (char !== ',') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
      }
    } else cell += char;
  }
  if (quoted) throw new Error('The CSV has an unclosed quoted value.');
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

const rules = [
  ['Food & drink', /coffee|cafe|restaurant|lunch|dinner|bakery|grocer|market|food/i],
  ['Transport', /train|metro|bus|taxi|uber|fuel|parking|transit/i],
  ['Subscriptions', /subscription|spotify|netflix|cloud|membership/i],
  ['Shopping', /shop|book|clothes|store|equipment/i],
  ['Housing', /rent|utility|electric|internet|water/i],
  ['Health', /pharmacy|doctor|dentist|gym|health/i],
];
export function importTransactions(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('Add a header and at least one transaction.');
  const headers = rows[0].map((h) => h.toLowerCase().replace(/^\uFEFF/, ''));
  const date = headers.findIndex((h) => ['date', 'transaction date'].includes(h));
  const description = headers.findIndex((h) =>
    ['description', 'merchant', 'name', 'memo'].includes(h),
  );
  const amount = headers.indexOf('amount');
  const category = headers.indexOf('category');
  if ([date, description, amount].some((n) => n < 0))
    throw new Error(
      'The CSV needs date, description, and amount columns. Expenses are negative; income is positive.',
    );
  if (rows.length > 10_001) throw new Error('Import at most 10,000 transactions at a time.');
  return rows.slice(1).map((row, index) => {
    if (row.length !== headers.length)
      throw new Error(`Row ${index + 2} has ${row.length} values; expected ${headers.length}.`);
    const raw = row[amount].replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
    if (!/^[+-]?\d+(\.\d{1,2})?$/.test(raw))
      throw new Error(
        `Row ${index + 2} has an invalid amount. Use dollars with up to two decimal places.`,
      );
    const cents = Math.round(Number(raw) * 100);
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > 1_000_000_000_00)
      throw new Error(`Row ${index + 2} has an amount outside the supported range.`);
    const value = row[date];
    const parsed = new Date(value);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    )
      throw new Error(`Row ${index + 2} needs a valid date in YYYY-MM-DD format.`);
    if (!row[description]) throw new Error(`Row ${index + 2} needs a description.`);
    return {
      id: `txn-${index}-${value}-${cents}`,
      date: value,
      description: row[description].slice(0, 300),
      cents,
      category:
        category >= 0 && row[category]
          ? row[category].slice(0, 80)
          : cents > 0
            ? 'Income'
            : rules.find(([, rule]) => rule.test(row[description]))?.[0] || 'Other',
    };
  });
}
export function summarizeTransactions(transactions) {
  let income = 0,
    expenses = 0;
  const groups = new Map();
  for (const txn of transactions) {
    if (txn.cents >= 0) income += txn.cents;
    else {
      expenses -= txn.cents;
      groups.set(txn.category, (groups.get(txn.category) || 0) - txn.cents);
    }
  }
  return {
    income,
    expenses,
    net: income - expenses,
    categories: [...groups]
      .map(([name, cents]) => ({ name, cents, percent: expenses ? (cents / expenses) * 100 : 0 }))
      .sort((a, b) => b.cents - a.cents),
    count: transactions.length,
  };
}
export const exampleCsv = `date,description,amount,category
2026-10-01,Monthly salary,4200.00,Income
2026-10-01,Apartment rent,-1250.00,Housing
2026-10-02,North Street Market,-74.80,Food & drink
2026-10-02,Metro card,-35.00,Transport
2026-10-03,Cloud subscription,-19.00,Subscriptions
2026-10-03,Riverside coffee,-6.50,Food & drink
2026-10-04,Neighborhood dinner,-48.00,Food & drink
2026-10-04,Bookshop,-32.00,Shopping
2026-10-05,Electricity,-68.40,Housing
2026-10-05,Music subscription,-10.99,Subscriptions
2026-10-06,Weekend groceries,-62.35,Food & drink
2026-10-06,Pharmacy,-18.50,Health
2026-10-07,Taxi home,-16.20,Transport
2026-10-07,Freelance project,450.00,Income`;
