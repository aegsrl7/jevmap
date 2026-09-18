import React, { useEffect, useState } from 'react';
import axios from 'axios';

// Inbox page: table of emails with an archive button.
export default function EmailList() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    axios.get('/api/emails').then((r) => setRows(r.data));
  }, []);
  const archive = (id) => axios.post(`/api/emails/${id}/archive`);
  return (
    <table>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.subject}</td>
            <td><button onClick={() => archive(r.id)}>Archive</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
