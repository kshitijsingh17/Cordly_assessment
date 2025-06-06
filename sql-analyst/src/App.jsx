import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import { Bar, Scatter } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  BarElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
  Legend,
} from 'chart.js';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

ChartJS.register(BarElement, CategoryScale, LinearScale, PointElement, Tooltip, Legend);

const API_URL = 'https://cordly-assessment.onrender.com';

function ChartBlock({ chart }) {
  if (!chart) return null;
  // Support both legacy and new chart format
  const type = chart.chartType || chart.type;
  const chartData = chart.chartData || chart.data;
  const scale = chart.scale || {};
  // Defensive: ensure chartData and chartData.data exist and are arrays
  if (!chartData || !Array.isArray(chartData.data)) {
    return <div style={{ color: '#ffb74d', margin: 8 }}>Invalid chart data.</div>;
  }
  if (type === 'bar') {
    const xKey = chartData.x;
    const yKey = chartData.y;
    if (!xKey || !yKey) {
      return <div style={{ color: '#ffb74d', margin: 8 }}>Missing x or y axis for bar chart.</div>;
    }
    const labels = chartData.data.map(row => row[xKey]);
    const values = chartData.data.map(row => row[yKey]);
    // Apply scale if provided
    const xScale = scale.x ? { min: scale.x.min, max: scale.x.max } : {};
    const yScale = scale.y ? { min: scale.y.min, max: scale.y.max } : {};
    // Always use default pixel size
    const pixelWidth = 600;
    const pixelHeight = 220;
    return (
      <div className="chat-chart-block">
        <Bar
          data={{
            labels,
            datasets: [{
              label: `${yKey} by ${xKey}`,
              data: values,
              backgroundColor: '#90caf9',
            }],
          }}
          options={{
            plugins: { legend: { labels: { color: '#eee' } } },
            scales: {
              x: { ticks: { color: '#eee' }, ...xScale },
              y: { ticks: { color: '#eee' }, ...yScale },
            },
            responsive: false,
            maintainAspectRatio: false,
          }}
          width={pixelWidth}
          height={pixelHeight}
        />
        {chart.chartDescription && (
          <div style={{ color: '#bbb', marginTop: 8, fontSize: '0.95em' }}>{chart.chartDescription}</div>
        )}
      </div>
    );
  }
  if (type === 'scatter') {
    const xKey = chartData.x;
    const yKey = chartData.y;
    if (!xKey || !yKey) {
      return <div style={{ color: '#ffb74d', margin: 8 }}>Missing x or y axis for scatter plot.</div>;
    }
    const xScale = scale.x ? { min: scale.x.min, max: scale.x.max } : {};
    const yScale = scale.y ? { min: scale.y.min, max: scale.y.max } : {};
    const pixelWidth = 600;
    const pixelHeight = 220;
    return (
      <div className="chat-chart-block">
        <Scatter
          data={{
            datasets: [{
              label: `${yKey} vs ${xKey}`,
              data: chartData.data.map(row => ({ x: row[xKey], y: row[yKey] })),
              backgroundColor: '#ffb74d',
            }],
          }}
          options={{
            plugins: { legend: { labels: { color: '#eee' } } },
            scales: {
              x: { title: { display: true, text: xKey, color: '#eee' }, ticks: { color: '#eee' }, ...xScale },
              y: { title: { display: true, text: yKey, color: '#eee' }, ticks: { color: '#eee' }, ...yScale },
            },
            responsive: false,
            maintainAspectRatio: false,
          }}
          width={pixelWidth}
          height={pixelHeight}
        />
        {chart.chartDescription && (
          <div style={{ color: '#bbb', marginTop: 8, fontSize: '0.95em' }}>{chart.chartDescription}</div>
        )}
      </div>
    );
  }
  // Add more chart types as needed
  return <div style={{ color: '#ffb74d', margin: 8 }}>Unsupported chart type.</div>;
}

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [user, setUser] = useState('User');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    fetch(`${API_URL}/history`)
      .then(res => res.json())
      .then(data => setMessages(data.reverse()));
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    const msg = { user, message: input };
    setMessages(prev => [...prev, { ...msg, response: '...', chart: null }]);
    setInput('');
    try {
      console.log('Sending to backend:', msg);
      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg)
      });
      let data;
      try {
        data = await res.json();
      } catch (jsonErr) {
        console.error('Failed to parse JSON from backend:', jsonErr);
        setMessages(prev => prev.slice(0, -1).concat({ ...msg, response: 'Error: Invalid JSON from server.', chart: null }));
        return;
      }
      console.log('Backend /chat response:', data);
      if (!res.ok) {
        setMessages(prev => prev.slice(0, -1).concat({ ...msg, response: `Server error: ${res.status}`, chart: null }));
        return;
      }
      setMessages(prev => prev.slice(0, -1).concat({
        ...msg,
        response: (typeof data.response === 'string' && data.response.trim()) ? data.response : 'No response from AI.',
        chart: data.chart || null,
        followup: data.followup || null,
        downloadUrl: data.downloadUrl || null,
        isFallback: data.response && (
          data.response.startsWith('Sorry, no database uploaded.') ||
          data.response.startsWith('Error processing database:') ||
          data.response.startsWith('Sorry, I could not process your request.')
        ),
        responseType: data.responseType || 'text'
      }));
    } catch (err) {
      console.error('Fetch error:', err);
      setMessages(prev => prev.slice(0, -1).concat({ ...msg, response: 'Error: Could not get response from server.', chart: null }));
    }
  };

  // Drag and drop handlers
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };
  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
      await autoUploadFile(e.dataTransfer.files[0]);
    }
  };

  // Auto-upload on file select or drop
  const autoUploadFile = async (selectedFile) => {
    if (!selectedFile) return;
    setUploading(true);
    const formData = new FormData();
    formData.append('dbfile', selectedFile);
    await fetch(`${API_URL}/upload`, {
      method: 'POST',
      body: formData
    });
    setUploading(false);
    setFile(null);
    alert('Database uploaded!');
  };

  const handleFileChange = async (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      await autoUploadFile(e.target.files[0]);
    }
  };

  const handleClearChat = async () => {
    await fetch(`${API_URL}/clear-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user })
    });
    setMessages([]);
  };

  return (
    <div
      className={`chat-root${dragActive ? ' drag-active' : ''}`}
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
      style={{ fontFamily: 'Inter, Segoe UI, Arial, sans-serif', fontWeight: 400 }}
    >
      <header className="chat-header">SQL Analyst Chatbot</header>
      {dragActive && (
        <div className="drag-overlay">
          <span>Drop your SQLite/.db/.sql file here to upload</span>
        </div>
      )}
      <div className="chat-history">
        {messages.map((msg, i) => (
          <div key={i} className="chat-msg-row">
            <div className={`chat-msg-bubble chat-msg-user-bubble${msg.user === user ? ' right' : ''}`}>{msg.user}:
              <div className="chat-msg-text">{msg.message}</div>
            </div>
            <div className="chat-msg-bubble chat-msg-bot-bubble left">
              <div className="chat-msg-bot">Bot:</div>
              <div className="chat-msg-response">
                {msg.isFallback && (
                  <div style={{ color: '#ffb74d', fontWeight: 500, marginBottom: 6 }}>
                    ⚠️ {msg.response.includes('no database uploaded') ? 'Please upload a SQLite/.db/.sql file before asking questions.' : msg.response}
                  </div>
                )}
                {/* Only render response if not null or empty */}
                {!msg.isFallback && msg.response && (
                  typeof msg.response === 'string' || (typeof msg.response === 'object' && msg.response !== null && 'markdown' in msg.response)
                    ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {typeof msg.response === 'object' && msg.response !== null && 'markdown' in msg.response
                            ? msg.response.markdown
                            : msg.response}
                        </ReactMarkdown>
                      )
                    : <span>{msg.response}</span>
                )}
                {/* Only render chart if not null */}
                {msg.chart && <ChartBlock chart={msg.chart} />}
                {/* Only render downloadUrl if not null */}
                {msg.downloadUrl && (
                  <div style={{ marginTop: 8 }}>
                    <a href={msg.downloadUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#90caf9' }}>
                      Download Full Insight
                    </a>
                  </div>
                )}
                {/* Only render followup if not null */}
                {msg.followup && <div className="chat-followup">💡 <em>{msg.followup}</em></div>}
              </div>
            </div>
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      <form className="chat-input-bar" onSubmit={handleSend}>
        <input
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask a question about your database..."
        />
        <input
          type="file"
          accept=".sqlite,.db,.sql"
          onChange={handleFileChange}
          style={{ color: '#bbb', width: 120, background: 'none', border: 'none', fontSize: '0.95em' }}
        />
        <button type="button" onClick={handleClearChat} style={{ marginLeft: 8 }}>
          Clear Chat
        </button>
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

export default App;
