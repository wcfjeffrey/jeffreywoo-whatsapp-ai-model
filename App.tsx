
import React, { useState, useMemo, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { 
  WhatsAppMessage, 
  RawParsedMessage, 
  AnalysisBatch, 
  CustomerCategory, 
  PriorityLevel,
  EntityType
} from './types';
import { parseWhatsAppChat } from './utils/whatsappParser';
import { analyzeCRMData, transcribeAudio } from './services/geminiService';

type SortKey = 'timestamp' | 'sender' | 'priority';
type SortDirection = 'asc' | 'desc';

const App: React.FC = () => {
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  // Known Entities State
  const [customerInput, setCustomerInput] = useState<string>(() => localStorage.getItem('knownCustomers') || '');
  const [vendorInput, setVendorInput] = useState<string>(() => localStorage.getItem('knownVendors') || '');
  const [spamInput, setSpamInput] = useState<string>(() => localStorage.getItem('knownSpam') || '');
  const [showEntitySettings, setShowEntitySettings] = useState(false);

  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [excelData, setExcelData] = useState<any[][] | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [filterType, setFilterType] = useState<EntityType | 'ALL'>('ALL');
  const [filterCategory, setFilterCategory] = useState<CustomerCategory | 'ALL'>('ALL');
  const [filterPriority, setFilterPriority] = useState<PriorityLevel | 'ALL'>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Sync settings to localStorage
  useEffect(() => {
    localStorage.setItem('knownCustomers', customerInput);
    localStorage.setItem('knownVendors', vendorInput);
    localStorage.setItem('knownSpam', spamInput);
  }, [customerInput, vendorInput, spamInput]);

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  const isAudioFile = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    return ['opus', 'ogg', 'm4a', 'mp3', 'wav'].includes(ext || '');
  };

  const getMimeType = (filename: string, originalType: string) => {
    if (originalType) return originalType;
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'opus': return 'audio/ogg; codecs=opus';
      case 'ogg': return 'audio/ogg';
      case 'm4a': return 'audio/mp4';
      case 'mp3': return 'audio/mpeg';
      case 'wav': return 'audio/wav';
      default: return 'audio/ogg';
    }
  };

  useEffect(() => {
    if (previewFile) {
      const url = URL.createObjectURL(previewFile);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
    }
  }, [previewFile]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setError(null);
    const fileArray: File[] = Array.from(files);
    
    const chatFile: File | undefined = fileArray.find(f => f.name === '_chat.txt') || 
                                       fileArray.find(f => f.name.toLowerCase().endsWith('.txt'));

    if (!chatFile) {
      setError("Missing chat log file (e.g. '_chat.txt'). Please select it along with your media files.");
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const mediaFiles = fileArray.filter(f => f !== chatFile);
    processAndAnalyze(chatFile, mediaFiles);
    
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const processAndAnalyze = async (chatFile: File, mediaFiles: File[]) => {
    setIsAnalyzing(true);
    setProgress(5);
    setError(null);

    try {
      const chatText = await chatFile.text();
      let rawMessages = parseWhatsAppChat(chatText);
      
      if (rawMessages.length === 0) {
        throw new Error("Could not parse messages. Please ensure the file is a valid WhatsApp chat export.");
      }

      setProgress(10);

      const knownCustomers = customerInput.split(/[,，\n]/).map(s => s.trim()).filter(s => s);
      const knownVendors = vendorInput.split(/[,，\n]/).map(s => s.trim()).filter(s => s);
      const knownSpam = spamInput.split(/[,，\n]/).map(s => s.trim()).filter(s => s);

      // --- VOICE MESSAGE TRANSCRIPTION & SUMMARIZATION ---
      const audioMessages = rawMessages.filter(msg => msg.attachmentName && isAudioFile(msg.attachmentName));
      if (audioMessages.length > 0) {
        const totalAudio = audioMessages.length;
        for (let i = 0; i < audioMessages.length; i++) {
          const msg = audioMessages[i];
          const cleanName = msg.attachmentName?.toLowerCase().trim();
          
          const matchedFile = mediaFiles.find(f => {
            const fileName = f.name.toLowerCase();
            return fileName === cleanName || fileName.includes(cleanName!) || cleanName!.includes(fileName);
          });
          
          if (matchedFile) {
            try {
              const base64 = await fileToBase64(matchedFile);
              const mime = getMimeType(matchedFile.name, matchedFile.type);
              const summary = await transcribeAudio(base64, mime);
              msg.content = summary; 
            } catch (err) {
              console.error("Transcription failed for:", matchedFile.name, err);
              msg.content = "[Transcription Failed]";
            }
          } else {
            msg.content = `[Voice Attachment: ${msg.attachmentName}] (File not uploaded)`;
          }
          setProgress(10 + Math.floor(((i + 1) / totalAudio) * 40)); 
        }
      } else {
        setProgress(30);
      }

      const senderBatches: Record<string, RawParsedMessage[]> = {};
      rawMessages.forEach(msg => {
        if (!senderBatches[msg.sender]) senderBatches[msg.sender] = [];
        senderBatches[msg.sender].push(msg);
      });

      const batches: AnalysisBatch[] = Object.keys(senderBatches).map(sender => ({
        sender,
        messages: senderBatches[sender]
      }));

      const chunkSize = 8;
      let allAnalyses: any[] = [];
      const currentProgress = progress;
      
      for (let i = 0; i < batches.length; i += chunkSize) {
        const chunk = batches.slice(i, i + chunkSize);
        const chunkAnalyses = await analyzeCRMData(chunk, knownCustomers, knownVendors, knownSpam);
        allAnalyses = [...allAnalyses, ...chunkAnalyses];
        setProgress(currentProgress + Math.floor((i / batches.length) * (95 - currentProgress)));
      }

      const finalMessages: WhatsAppMessage[] = rawMessages.map((raw, idx) => {
        const analysis = allAnalyses.find(a => 
          a.sender === raw.sender && a.timestamp === raw.timestamp
        );
        
        let matchedFile: File | undefined;
        if (raw.attachmentName) {
          const cleanName = raw.attachmentName.toLowerCase().trim();
          matchedFile = mediaFiles.find(f => {
            const fileName = f.name.toLowerCase();
            return fileName === cleanName || fileName.includes(cleanName) || cleanName.includes(fileName);
          });
        }

        // --- STRICT CLASSIFICATION LOGIC ---
        // 1. Default to UNKNOWN
        let determinedType = EntityType.UNKNOWN;
        
        const senderLower = raw.sender.toLowerCase();

        // 2. Priority 1: Manual Check (Customer/Vendor/Spam)
        if (knownSpam.some(spamItem => senderLower.includes(spamItem.toLowerCase()))) {
          determinedType = EntityType.SPAM;
        } else if (knownCustomers.some(name => senderLower.includes(name.toLowerCase()))) {
          determinedType = EntityType.CUSTOMER;
        } else if (knownVendors.some(name => senderLower.includes(name.toLowerCase()))) {
          determinedType = EntityType.VENDOR;
        } 
        // 3. Priority 2: AI Spam detection (only if not found in lists)
        else if (analysis?.type === EntityType.SPAM) {
          determinedType = EntityType.SPAM;
        }
        // 4. Note: AI guess for VENDOR/CUSTOMER is NOT used as the main label 
        // if they are not in the manual lists. They remain UNKNOWN.
        // We put the AI's hint in the 'todo' field.

        return {
          id: `msg-${idx}`,
          timestamp: raw.timestamp,
          sender: raw.sender,
          content: raw.content,
          attachmentName: raw.attachmentName,
          attachmentFile: matchedFile,
          attachmentPath: matchedFile ? matchedFile.name : undefined,
          type: determinedType,
          category: (analysis?.category as CustomerCategory) || CustomerCategory.LOW_PRIORITY,
          priority: (analysis?.priority as PriorityLevel) || PriorityLevel.LOW,
          todo: (determinedType === EntityType.UNKNOWN && (analysis?.type === EntityType.VENDOR || analysis?.type === EntityType.CUSTOMER)) 
            ? `[Possible ${analysis.type}] ${analysis.todo}` 
            : (analysis?.todo || 'To be verified')
        };
      });

      setMessages(finalMessages);
      setProgress(100);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Analysis failed.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleOpenPreview = async (file: File) => {
    setPreviewFile(file);
    setExcelData(null);

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data);
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
        setExcelData(jsonData);
      } catch (e) {
        console.error("Failed to parse Excel for preview", e);
      }
    }
  };

  const downloadFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const openInBrowser = (file: File) => {
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
  };

  const exportToExcel = () => {
    const exportData = filteredAndSortedMessages.map(m => ({
      Timestamp: m.timestamp,
      Sender: m.sender,
      Type: m.type,
      Category: m.category,
      Priority: m.priority,
      Message: m.content,
      Attachment: m.attachmentName || '',
      'AI Recommendation': m.todo
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Analysis");
    XLSX.writeFile(workbook, `CRM_Analysis_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const stats = useMemo(() => ({
    total: messages.length,
    customers: messages.filter(m => m.type === EntityType.CUSTOMER).length,
    vendors: messages.filter(m => m.type === EntityType.VENDOR).length,
    spam: messages.filter(m => m.type === EntityType.SPAM).length,
    highPriority: messages.filter(m => m.priority === PriorityLevel.HIGH).length,
  }), [messages]);

  const filteredAndSortedMessages = useMemo(() => {
    let result = [...messages];
    if (filterType !== 'ALL') result = result.filter(m => m.type === filterType);
    if (filterCategory !== 'ALL') result = result.filter(m => m.category === filterCategory);
    if (filterPriority !== 'ALL') result = result.filter(m => m.priority === filterPriority);

    result.sort((a, b) => {
      let comparison = 0;
      if (sortKey === 'timestamp') comparison = a.timestamp.localeCompare(b.timestamp);
      else if (sortKey === 'sender') comparison = a.sender.localeCompare(b.sender);
      else if (sortKey === 'priority') {
        const pWeight = { [PriorityLevel.HIGH]: 3, [PriorityLevel.MEDIUM]: 2, [PriorityLevel.LOW]: 1 };
        comparison = (pWeight[a.priority] || 0) - (pWeight[b.priority] || 0);
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return result;
  }, [messages, filterType, filterCategory, filterPriority, sortKey, sortDirection]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 font-sans selection:bg-blue-100">
      <header className="bg-white border-b sticky top-0 z-30 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-600 text-white p-2.5 rounded-2xl shadow-lg shadow-emerald-100">
            <i className="bi bi-whatsapp text-2xl"></i>
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight text-gray-800">JeffreyWoo WhatsApp CRM & SRM</h1>
            <p className="text-[9px] text-gray-400 font-black uppercase tracking-[0.3em]">AI-Powered Intelligence</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button 
            onClick={() => setShowEntitySettings(!showEntitySettings)}
            className="flex items-center gap-2 px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-all font-bold text-sm"
          >
            <i className="bi bi-person-lines-fill"></i>
            Manage Lists
          </button>
          {messages.length > 0 && (
            <button onClick={exportToExcel} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl flex items-center gap-3 transition-all shadow-md active:scale-95">
              <i className="bi bi-download"></i>
              <span className="font-bold text-sm">Export to Excel</span>
            </button>
          )}
        </div>
      </header>

      {/* Entity Lists Settings */}
      {showEntitySettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="bg-white w-full max-w-xl rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in duration-200">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xl font-black text-slate-800">Identification Lists</h3>
              <button onClick={() => setShowEntitySettings(false)} className="text-slate-400 hover:text-slate-600 text-xl"><i className="bi bi-x-lg"></i></button>
            </div>
            <div className="p-8 space-y-6 max-h-[70vh] overflow-y-auto">
              <p className="text-sm text-slate-500 font-medium">Help the AI distinguish between customers, vendors, and spam by adding names or numbers below.</p>
              
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                  <i className="bi bi-person-check-fill text-emerald-500"></i> Customer List
                </label>
                <textarea 
                  value={customerInput}
                  onChange={(e) => setCustomerInput(e.target.value)}
                  placeholder="e.g. John Doe, Alice Smith"
                  className="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                  <i className="bi bi-truck text-indigo-500"></i> Vendor List
                </label>
                <textarea 
                  value={vendorInput}
                  onChange={(e) => setVendorInput(e.target.value)}
                  placeholder="e.g. DHL, Global Supplies"
                  className="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-rose-400 uppercase tracking-widest flex items-center gap-2">
                  <i className="bi bi-slash-circle text-rose-500"></i> Spam / Block List
                </label>
                <textarea 
                  value={spamInput}
                  onChange={(e) => setSpamInput(e.target.value)}
                  placeholder="e.g. +1234567, Unwanted Sales"
                  className="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm focus:ring-2 focus:ring-rose-500 outline-none transition-all"
                />
              </div>

              <button 
                onClick={() => setShowEntitySettings(false)}
                className="w-full bg-slate-900 hover:bg-black text-white py-4 rounded-2xl font-black transition-all shadow-lg active:scale-95 mt-4"
              >
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
        {messages.length === 0 && !isAnalyzing && (
          <div className="bg-white border border-gray-100 rounded-[2rem] p-16 text-center max-w-2xl mx-auto mt-12 shadow-2xl">
            <div className="bg-blue-50 w-24 h-24 rounded-[1.5rem] flex items-center justify-center mx-auto mb-10">
              <i className="bi bi-cloud-arrow-up text-blue-500 text-4xl"></i>
            </div>
            <h2 className="text-3xl font-black mb-4 text-gray-900 tracking-tight">Import WhatsApp Logs</h2>
            <p className="text-gray-500 mb-6 leading-relaxed max-w-sm mx-auto font-medium text-lg text-center">
              Please upload your <b>_chat.txt</b> file along with any media files. The AI system will automatically transcribe and summarize voice messages, then generate CRM and SRM insights.
            </p>
            <div className="flex justify-center gap-4 mb-12">
               <button onClick={() => setShowEntitySettings(true)} className="px-6 py-3 border border-slate-200 rounded-xl text-slate-600 font-bold text-sm hover:bg-slate-50 transition-all flex items-center gap-2">
                 <i className="bi bi-gear"></i> Set Name Lists First
               </button>
            </div>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileUpload} />
            <button onClick={() => fileInputRef.current?.click()} className="bg-blue-600 hover:bg-blue-700 text-white px-12 py-5 rounded-2xl font-black text-lg transition-all shadow-xl active:scale-95 flex items-center gap-4 mx-auto">
              <i className="bi bi-plus-lg text-2xl"></i> Select Files to Analyze
            </button>
            {error && <div className="mt-8 p-4 bg-rose-50 text-rose-700 rounded-2xl border border-rose-100 font-bold text-sm max-w-md mx-auto">{error}</div>}
          </div>
        )}

        {isAnalyzing && (
          <div className="bg-white border border-gray-100 rounded-[2rem] p-20 text-center max-w-xl mx-auto mt-20 shadow-2xl">
            <div className="relative w-24 h-24 mx-auto mb-12">
              <div className="absolute inset-0 border-4 border-blue-50 rounded-full"></div>
              <div className="absolute inset-0 border-4 border-blue-600 rounded-full border-t-transparent animate-spin"></div>
              <div className="absolute inset-0 flex items-center justify-center"><i className="bi bi-magic text-3xl text-blue-600"></i></div>
            </div>
            <h2 className="text-3xl font-black mb-4 text-gray-900 italic tracking-tight">Analyzing Threads...</h2>
            <div className="w-full bg-slate-100 h-2.5 rounded-full mb-8 overflow-hidden max-w-xs mx-auto shadow-inner">
              <div className="bg-blue-600 h-full duration-700 ease-out" style={{ width: `${progress}%` }}></div>
            </div>
            <p className="text-gray-400 font-bold uppercase tracking-[0.2em] text-[10px]">TRANSCRIBING VOICE MESSAGES & BUILDING CRM & SRM INSIGHTS</p>
          </div>
        )}

        {messages.length > 0 && !isAnalyzing && (
          <>
            {error && <div className="p-4 mb-6 bg-rose-50 text-rose-700 rounded-2xl border border-rose-100 font-bold text-sm">{error}</div>}
            
            <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
              <StatCard title="Messages" value={stats.total} icon="activity" color="blue" />
              <StatCard title="Customers" value={stats.customers} icon="person-check-fill" color="green" />
              <StatCard title="Vendors" value={stats.vendors} icon="truck" color="purple" />
              <StatCard title="SPAM" value={stats.spam} icon="slash-circle" color="red" />
              <StatCard title="High Priority" value={stats.highPriority} icon="exclamation-octagon-fill" color="orange" />
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Filter By:</span>
                <select value={filterType} onChange={(e) => setFilterType(e.target.value as any)} className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="ALL">All Types</option>
                  {Object.values(EntityType).map(type => <option key={type} value={type}>{type}</option>)}
                </select>
                <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value as any)} className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="ALL">All Categories</option>
                  {Object.values(CustomerCategory).map(cat => <option key={cat} value={cat}>{cat}</option>)}
                </select>
                <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value as any)} className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="ALL">All Priority</option>
                  {Object.values(PriorityLevel).map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>

              <div className="flex items-center gap-3 ml-auto">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Sort By:</span>
                <div className="flex bg-slate-100 rounded-lg p-1 gap-1">
                  <SortButton active={sortKey === 'timestamp'} onClick={() => toggleSort('timestamp')} direction={sortKey === 'timestamp' ? sortDirection : undefined}>Timeline</SortButton>
                  <SortButton active={sortKey === 'sender'} onClick={() => toggleSort('sender')} direction={sortKey === 'sender' ? sortDirection : undefined}>Sender</SortButton>
                  <SortButton active={sortKey === 'priority'} onClick={() => toggleSort('priority')} direction={sortKey === 'priority' ? sortDirection : undefined}>Priority</SortButton>
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50/50 border-b border-slate-100">
                      <th className="p-5 font-black text-[10px] text-slate-400 uppercase tracking-widest whitespace-nowrap">Time</th>
                      <th className="p-5 font-black text-[10px] text-slate-400 uppercase tracking-widest">Entity</th>
                      <th className="p-5 font-black text-[10px] text-slate-400 uppercase tracking-widest">Sender</th>
                      <th className="p-5 font-black text-[10px] text-slate-400 uppercase tracking-widest">Message Snippet</th>
                      <th className="p-5 font-black text-[10px] text-slate-400 uppercase tracking-widest text-center">Attachment</th>
                      <th className="p-5 font-black text-[10px] text-slate-400 uppercase tracking-widest">Category</th>
                      <th className="p-5 font-black text-[10px] text-slate-400 uppercase tracking-widest">Priority</th>
                      <th className="p-5 font-black text-[10px] text-slate-400 uppercase tracking-widest">AI Recommendation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {filteredAndSortedMessages.map((msg) => (
                      <tr key={msg.id} className={`hover:bg-slate-50/80 transition-all group ${msg.type === EntityType.SPAM ? 'opacity-60 grayscale-[0.5]' : ''}`}>
                        <td className="p-5 text-[11px] text-slate-400 whitespace-nowrap font-mono">{msg.timestamp}</td>
                        <td className="p-5 whitespace-nowrap">
                          <span className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider border ${getTypeStyle(msg.type)}`}>
                            {msg.type}
                          </span>
                        </td>
                        <td className="p-5 font-bold text-sm text-slate-800 whitespace-nowrap">{msg.sender}</td>
                        <td className="p-5 text-sm text-slate-600 max-w-xs font-medium" title={msg.content}>
                          <div className="line-clamp-2 leading-relaxed">{msg.content}</div>
                        </td>
                        <td className="p-5 text-center">
                          {msg.attachmentName ? (
                            <button 
                              onClick={() => msg.attachmentFile && handleOpenPreview(msg.attachmentFile)} 
                              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all ${
                                msg.attachmentFile 
                                  ? 'bg-white border-blue-200 text-blue-600 hover:bg-blue-600 hover:text-white hover:border-blue-600 shadow-sm' 
                                  : 'bg-slate-50 border-slate-100 text-slate-300 cursor-not-allowed'
                              }`}
                            >
                              <i className={`bi ${getFileIcon(msg.attachmentName)}`}></i>
                              <span className="font-bold text-[10px]">{msg.attachmentFile ? 'View' : 'None'}</span>
                            </button>
                          ) : <span className="text-slate-200">—</span>}
                        </td>
                        <td className="p-5 whitespace-nowrap">
                          <span className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide ${getCategoryStyle(msg.category)}`}>
                            {msg.category}
                          </span>
                        </td>
                        <td className="p-5 whitespace-nowrap">
                          <span className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide ${getPriorityStyle(msg.priority)}`}>
                            {msg.priority}
                          </span>
                        </td>
                        <td className="p-5 min-w-[200px]">
                          <div className="flex items-start gap-2 text-[11px] font-bold text-slate-600 bg-blue-50/50 p-3 rounded-xl border border-blue-100/50">
                            <i className="bi bi-robot text-blue-500"></i>
                            <span className="leading-snug">{msg.todo}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex justify-center pt-8 pb-12">
              <button onClick={() => setMessages([])} className="text-slate-300 hover:text-rose-500 transition-all text-[9px] font-black uppercase tracking-[0.4em] flex items-center gap-3 px-8 py-4">
                <i className="bi bi-trash3-fill"></i> Reset Workspace
              </button>
            </div>
          </>
        )}
      </main>

      {/* Media Preview Modal */}
      {previewFile && previewUrl && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-all animate-in fade-in duration-200">
          <div className="bg-[#f3f3f3] w-full h-full md:w-[95vw] md:h-[90vh] md:rounded-xl shadow-2xl overflow-hidden flex flex-col relative border border-white/20 animate-in zoom-in duration-300">
            <div className="h-14 flex items-center justify-between px-4 bg-white/95 backdrop-blur border-b border-slate-200 sticky top-0 z-20">
              <div className="flex items-center gap-4 min-w-0">
                <div className="flex items-center gap-2 bg-slate-100 rounded-lg px-3 py-1.5 border border-slate-200 max-w-sm truncate">
                   <i className={`bi ${getFileIcon(previewFile.name)} text-blue-600`}></i>
                   <span className="text-sm font-semibold text-slate-700 truncate">{previewFile.name}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => openInBrowser(previewFile)} className="h-10 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-2 transition-all font-bold text-xs shadow-sm shadow-blue-100">
                  <i className="bi bi-box-arrow-up-right"></i>
                  <span className="hidden sm:inline">Browser Tab</span>
                </button>
                <div className="w-px h-6 bg-slate-200 mx-2"></div>
                <button onClick={() => downloadFile(previewFile)} className="w-10 h-10 flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded-lg transition-all" title="Download">
                  <i className="bi bi-download"></i>
                </button>
                <button onClick={() => setPreviewFile(null)} className="w-10 h-10 flex items-center justify-center text-slate-600 hover:bg-rose-50 hover:text-rose-500 rounded-lg transition-all" title="Close">
                  <i className="bi bi-x-lg"></i>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-[#525659] flex items-center justify-center p-4">
              <div className="w-full h-full max-w-7xl mx-auto flex items-center justify-center">
                {previewFile.type === 'application/pdf' ? (
                  <iframe src={previewUrl} className="w-full h-full bg-white shadow-2xl rounded-sm border-none" title="PDF Preview" />
                ) : excelData ? (
                  <div className="w-full h-full bg-white rounded-sm shadow-xl border border-slate-300 overflow-auto p-2">
                    <table className="w-full text-left border-collapse text-[11px] font-sans">
                      <tbody>
                        {excelData.map((row, rIdx) => (
                          <tr key={rIdx} className={rIdx === 0 ? 'bg-[#f8f9fa] border-b-2 border-slate-200 font-bold' : 'border-b border-slate-100 hover:bg-slate-50'}>
                            {row.map((cell, cIdx) => (
                              <td key={cIdx} className="p-2 border-r border-slate-100 whitespace-nowrap min-w-[80px]">{String(cell || '')}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : previewFile.type.startsWith('image/') ? (
                  <img src={previewUrl} className="max-w-full max-h-[80vh] object-contain shadow-2xl border-2 border-white/10" alt="Preview" />
                ) : previewFile.type.startsWith('video/') ? (
                  <video controls className="max-w-full max-h-[80vh] rounded-lg shadow-2xl outline-none bg-black">
                    <source src={previewUrl} type={previewFile.type} />
                  </video>
                ) : isAudioFile(previewFile.name) || previewFile.type.startsWith('audio/') ? (
                  <div className="bg-white p-12 rounded-2xl shadow-2xl max-w-lg w-full text-center">
                    <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-inner">
                       <i className="bi bi-mic text-4xl"></i>
                    </div>
                    <h4 className="text-xl font-black text-slate-800 mb-6 tracking-tight">Voice Message Playback</h4>
                    <audio controls className="w-full outline-none mb-8">
                      <source src={previewUrl} type={getMimeType(previewFile.name, previewFile.type)} />
                    </audio>
                    <button onClick={() => downloadFile(previewFile)} className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-4 rounded-xl transition-all">Download Audio</button>
                  </div>
                ) : (
                  <div className="bg-white p-12 rounded-2xl shadow-2xl max-w-lg w-full text-center">
                    <div className="w-20 h-20 bg-slate-100 text-slate-400 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-inner">
                       <i className={`bi ${getFileIcon(previewFile.name)} text-4xl`}></i>
                    </div>
                    <h4 className="text-xl font-black text-slate-800 mb-3 tracking-tight">Generic File</h4>
                    <button onClick={() => openInBrowser(previewFile)} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-black py-4 rounded-xl transition-all">Open Native</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const StatCard = ({ title, value, icon, color }: { title: string, value: number, icon: string, color: string }) => {
  const colorMap: Record<string, string> = { 
    blue: 'bg-blue-600 shadow-blue-100', 
    red: 'bg-rose-500 shadow-rose-100', 
    green: 'bg-emerald-600 shadow-emerald-100', 
    purple: 'bg-indigo-600 shadow-indigo-100',
    orange: 'bg-orange-500 shadow-orange-100'
  };
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all group">
      <div className="flex items-center gap-5">
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-white ${colorMap[color]} group-hover:scale-110 transition-transform`}>
          <i className={`bi bi-${icon} text-xl`}></i>
        </div>
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{title}</p>
          <p className="text-2xl font-black text-slate-900">{value}</p>
        </div>
      </div>
    </div>
  );
};

const SortButton: React.FC<{ active: boolean, direction?: SortDirection, onClick: () => void, children: React.ReactNode }> = ({ active, direction, onClick, children }) => (
  <button onClick={onClick} className={`px-4 py-2 rounded-md text-[10px] font-black uppercase tracking-wider transition-all flex items-center gap-2 ${active ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
    {children}
    {active && <i className={`bi bi-chevron-${direction === 'asc' ? 'up' : 'down'} text-[8px] stroke-[3px]`}></i>}
  </button>
);

const getFileIcon = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg': case 'jpeg': case 'png': case 'gif': case 'webp': return 'bi-image';
    case 'pdf': return 'bi-file-pdf';
    case 'xlsx': case 'xls': case 'csv': return 'bi-file-spreadsheet';
    case 'mp4': return 'bi-play-circle';
    case 'opus': case 'ogg': case 'm4a': case 'mp3': case 'wav': return 'bi-mic';
    default: return 'bi-file-earmark';
  }
};

const getTypeStyle = (type: EntityType) => {
  switch (type) {
    case EntityType.CUSTOMER: return 'bg-emerald-50 text-emerald-700 border-emerald-100';
    case EntityType.VENDOR: return 'bg-blue-50 text-blue-700 border-blue-100';
    case EntityType.SPAM: return 'bg-rose-500 text-white border-rose-600';
    default: return 'bg-slate-50 text-slate-500 border-slate-200';
  }
};

const getCategoryStyle = (cat: CustomerCategory) => {
  switch (cat) {
    case CustomerCategory.NEW: return 'bg-blue-50 text-blue-600';
    case CustomerCategory.EXISTING: return 'bg-slate-100 text-slate-600';
    case CustomerCategory.INQUIRY: return 'bg-amber-50 text-amber-700';
    case CustomerCategory.FOLLOW_UP: return 'bg-rose-50 text-rose-600';
    default: return 'bg-slate-50 text-slate-400';
  }
};

const getPriorityStyle = (priority: PriorityLevel) => {
  switch (priority) {
    case PriorityLevel.HIGH: return 'bg-rose-500 text-white shadow-sm';
    case PriorityLevel.MEDIUM: return 'bg-amber-100 text-amber-700';
    case PriorityLevel.LOW: return 'bg-slate-100 text-slate-500';
  }
};

export default App;
