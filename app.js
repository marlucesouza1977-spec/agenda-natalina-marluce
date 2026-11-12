(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const config = window.AGENDA_CONFIG || {};
  const supabaseUrl = String(config.supabaseUrl || '').trim().replace(/\/+$/, '');
  const supabaseKey = String(config.supabasePublishableKey || '').trim();
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) && /^(sb_publishable_|eyJ)/.test(supabaseKey);

  let db;
  let records = [];
  let selectedDate = '2026-12-02';
  let month = '2026-12';
  let editId = null;
  let currentView = 'hoje';
  let loadToken = 0;

  const minDate = '2026-12-02';
  const maxDate = '2027-01-18';
  const statuses = {
    pendente: 'Aguardando sinal',
    confirmado: 'Confirmado',
    concluido: 'Concluído',
    cancelado: 'Cancelado'
  };

  // Horários de 10:00 até 18:00 (9 horários disponíveis por dia)
  const slotTimes = Array.from({ length: 9 }, (_, i) => String(i + 10).padStart(2, '0') + ':00');

  const money = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const escapeHTML = t => String(t ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
  const dateLabel = s => new Date(s + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const dateBrief = s => new Date(s + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  const inRange = d => d >= minDate && d <= maxDate;
  const active = r => r.status !== 'cancelado';
  const getInitial = name => (String(name || '').trim()[0] || '?').toUpperCase();

  const alertMsg = (t, visible = true) => {
    $('#notice').textContent = t;
    $('#notice').classList.toggle('hidden', !visible);
  };

  const setSync = (text, ok = false) => {
    const e = $('#sync-status');
    e.textContent = '● ' + text;
    e.className = 'sync-status ' + (ok ? 'online' : 'offline');
  };

  const display = mode => {
    for (const id of ['setup-screen', 'login-screen', 'app-content']) {
      $('#' + id).classList.toggle('hidden', id !== mode);
    }
    document.body.classList.toggle('authenticated', mode === 'app-content');
  };

  function cleanPhone(p) {
    let x = String(p || '').replace(/\D/g, '');
    if (x.startsWith('55') && (x.length === 12 || x.length === 13)) x = x.slice(2);
    if (x.startsWith('0') && (x.length === 11 || x.length === 12)) x = x.slice(1);
    return x;
  }

  function formatPhone(p) {
    const d = cleanPhone(p);
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return String(p || '');
  }

  function whatsappLink(phone, message) {
    const p = cleanPhone(phone);
    return `https://wa.me/55${p}?text=${encodeURIComponent(message)}`;
  }

  // Todas as datas relativas consideram a cidade do estúdio (Rio de Janeiro).
  const RIO_TZ = 'America/Sao_Paulo';
  const rioFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: RIO_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  function rioNow() {
    const parts = Object.fromEntries(rioFormatter.formatToParts(new Date())
      .filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      minute: Number(parts.hour) * 60 + Number(parts.minute)
    };
  }

  function shiftDate(iso, shift) {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + shift);
    return d.toISOString().slice(0, 10);
  }

  function dayDifference(iso, base = rioNow().date) {
    const a = Date.parse(`${iso}T12:00:00Z`);
    const b = Date.parse(`${base}T12:00:00Z`);
    return Math.round((a - b) / 86400000);
  }

  function minutesUntil(r) {
    const now = rioNow();
    const [h, m] = String(r.start_time || '10:00').split(':').map(Number);
    return dayDifference(r.session_date, now.date) * 1440 + (h * 60 + m) - now.minute;
  }

  function proximityText(r) {
    const minutes = minutesUntil(r);
    const days = dayDifference(r.session_date);
    if (minutes < 0) return 'Horário já passou';
    if (days === 0) {
      if (minutes < 60) return `Em ${minutes} min`;
      return `Em ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2,'0')}`;
    }
    if (days === 1) return 'Amanhã';
    return `Faltam ${days} dias`;
  }

  function formatFullDate(iso) {
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', {
      timeZone: 'UTC', day: '2-digit', month: 'long', year: 'numeric'
    });
  }

  function messageFor(r) {
    const firstName = String(r.client_name || '').trim().split(/\s+/)[0] || 'tudo bem';
    const when = formatFullDate(r.session_date);
    const hour = String(r.start_time || '').slice(0, 5);
    const days = dayDifference(r.session_date);
    const pending = r.status === 'pendente';
    const opening = `Olá, ${firstName}! Tudo bem? Aqui é da Marluce Souza Fotografia.`;
    const scheduling = pending ? 'Sua pré-reserva de ensaio de Natal' : 'Seu ensaio de Natal';
    if (r.status === 'concluido') {
      return `${opening}\nMuito obrigada por fotografar com a gente! Foi um prazer receber você. ✨`;
    }
    if (days < 0) {
      return `${opening}\nEstamos entrando em contato sobre o seu ensaio marcado para ${when}, às ${hour}. Podemos conversar?`;
    }
    if (days === 0) {
      return `${opening}\nÉ hoje! Seu ensaio de Natal está marcado para as ${hour}. Estamos esperando você! Caso tenha algum imprevisto, avise por aqui.`;
    }
    if (days === 1) {
      if (pending) {
        return `${opening}\nSua pré-reserva de Natal está prevista para *amanhã*, ${when}, às *${hour}*. Para confirmar o horário, ainda precisamos receber o sinal combinado. Pode nos dar um retorno?`;
      }
      return `${opening}\nSeu ensaio de Natal é *amanhã*, ${when}, às *${hour}*. Pode responder *CONFIRMO* para sabermos que está tudo certo? Obrigada!`;
    }
    if (days <= 7) {
      return `${opening}\nFaltam apenas *${days} dias* para o seu ensaio de Natal, previsto para ${when}, às *${hour}*. Estamos preparando tudo com carinho! Caso precise remarcar, avise com antecedência.`;
    }
    return `${opening}\n${scheduling} está prevista para ${when}, às ${hour}. Faltam ${days} dias. Qualquer dúvida sobre roupas e tamanhos, pode chamar por aqui!`;
  }

  function isTomorrow(r) {
    return r.session_date === shiftDate(rioNow().date, 1) && active(r);
  }

  function attendanceLabel(status) {
    return ({pendente:'Aguardando contato', enviado:'Mensagem enviada',
      confirmado:'Presença confirmada', nao_confirmado:'Não confirmou'})[status] || 'Aguardando contato';
  }

  function renderStats() {
    const valid = records.filter(active);
    const confirmed = valid.filter(x => x.status !== 'pendente');
    const pending = valid.filter(x => x.status === 'pendente');
    const paid = valid.reduce((n, x) => n + Number(x.paid_amount || 0), 0);

    const cards = [
      ['Ensaios ativos', valid.length, 'Nesta campanha'],
      ['Confirmados', confirmed.length, 'Sinal confirmado'],
      ['Aguardando sinal', pending.length, 'Reservas pendentes'],
      ['Total recebido', money(paid), 'Pagamentos registrados']
    ];

    $('#stats').innerHTML = cards.map(([name, value, note]) => `
      <div class="stat">
        <label>${name}</label>
        <strong>${value}</strong>
        <div class="stat-note">${note}</div>
      </div>
    `).join('');
  }

  function renderCalendar() {
    const [y, m] = month.split('-').map(Number);
    const count = new Date(y, m, 0).getDate();
    const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;

    $('#month-label').textContent = new Date(y, m - 1, 1)
      .toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
      .replace(/^./, c => c.toUpperCase());

    $('#prev-month').disabled = month <= '2026-12';
    $('#next-month').disabled = month >= '2027-01';

    const cells = Array.from({ length: offset }, () => '<div aria-hidden="true"></div>');

    for (let d = 1; d <= count; d++) {
      const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const valid = inRange(ds);
      const res = records.filter(r => r.session_date === ds && active(r)).length;

      cells.push(`
        <button type="button" class="date-cell ${!valid ? 'outside' : ''} ${ds === selectedDate ? 'selected' : ''}" data-date="${ds}" ${!valid ? 'disabled' : ''} aria-label="Dia ${d}, ${res} ensaios">
          <span class="num">${d}</span>
          ${valid ? (res ? `<span class="count">${res} ensaio${res > 1 ? 's' : ''}</span>` : '<span class="free"></span>') : ''}
        </button>
      `);
    }

    $('#calendar').innerHTML = cells.join('');
    renderSlots();
  }

  function renderSlots() {
    $('#selected-date-title').textContent = dateLabel(selectedDate).replace(/^./, c => c.toUpperCase());
    const todayRecords = records.filter(r => r.session_date === selectedDate && active(r));
    $('#day-caption').textContent = `${todayRecords.length} agendamento${todayRecords.length !== 1 ? 's' : ''} · 10h às 18h`;

    const extraTimes = todayRecords
      .map(r => String(r.start_time || '').slice(0, 5))
      .filter(t => t && !slotTimes.includes(t));
    const allTimes = [...new Set([...slotTimes, ...extraTimes])].sort();

    $('#slots').innerHTML = allTimes.map(t => {
      const r = todayRecords.find(x => String(x.start_time || '').slice(0, 5) === t);
      if (!r) {
        return `
          <div class="slot free-slot" role="button" tabindex="0" data-new-slot="${t}">
            <span class="slot-time">${t}</span>
            <div class="slot-body">
              <strong>Horário disponível</strong>
              <small>Adicionar um ensaio</small>
            </div>
            <span class="slot-status">＋</span>
          </div>
        `;
      }

      const subject = r.subject_name ? ` · ${escapeHTML(r.subject_name)}` : '';
      return `
        <div class="slot ${r.status === 'pendente' ? 'booked' : 'confirmed'}">
          <span class="slot-time">${t}</span>
          <div class="slot-body">
            <strong>${escapeHTML(r.client_name)}${subject}</strong>
            <small>${escapeHTML(statuses[r.status] || r.status)} · ${escapeHTML(proximityText(r))}</small>
          </div>
          <button type="button" class="mini-btn" data-whatsapp="${r.id}">WhatsApp</button>
          <button type="button" class="mini-btn" data-edit="${r.id}" aria-label="Editar ${escapeHTML(r.client_name)}">Editar</button>
        </div>
      `;
    }).join('');
  }

  function openModal(record = null, time = null) {
    editId = record?.id || null;
    const f = $('#appointment-form');
    f.reset();

    const recordTime = record?.start_time ? String(record.start_time).slice(0, 5) : null;
    const availableOptions = recordTime && !slotTimes.includes(recordTime)
      ? [...slotTimes, recordTime].sort()
      : slotTimes;

    f.elements['start_time'].innerHTML = availableOptions.map(t => `<option value="${t}">${t}</option>`).join('');

    $('#modal-title').textContent = record ? 'Editar ensaio' : 'Novo ensaio';
    $('#delete-btn').classList.toggle('hidden', !record);
    $('#form-error').classList.add('hidden');

    const defaults = {
      client_name: '',
      phone: '',
      subject_name: '',
      session_date: inRange(selectedDate) ? selectedDate : minDate,
      start_time: time || '10:00',
      session_type: 'Natalino',
      clothing_size: '',
      status: 'pendente',
      total_amount: 200,
      paid_amount: 0,
      notes: ''
    };

    const data = { ...defaults, ...record };
    Object.keys(defaults).forEach(k => {
      if (k === 'start_time') {
        f.elements[k].value = String(data[k] || '10:00').slice(0, 5);
      } else if (k === 'phone') {
        f.elements[k].value = data[k] ? formatPhone(data[k]) : '';
      } else {
        f.elements[k].value = data[k] ?? '';
      }
    });

    $('#modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => f.elements.client_name.focus(), 20);
  }

  function closeModal() {
    $('#modal').classList.add('hidden');
    document.body.style.overflow = '';
  }

  function renderClients() {
    const rawSearch = $('#search').value.trim().toLocaleLowerCase('pt-BR');
    const digitSearch = rawSearch.replace(/\D/g, '');

    const items = records
      .filter(r => {
        if (!rawSearch) return true;
        const textMatch = [r.client_name, r.subject_name, formatPhone(r.phone)]
          .join(' ')
          .toLocaleLowerCase('pt-BR')
          .includes(rawSearch);
        const phoneMatch = digitSearch.length > 0 && cleanPhone(r.phone).includes(digitSearch);
        return textMatch || phoneMatch;
      })
      .sort((a, b) => (a.session_date + a.start_time).localeCompare(b.session_date + b.start_time));

    $('#client-list').innerHTML = items.length
      ? items.map(r => `
        <div class="list-row">
          <span class="avatar">${escapeHTML(getInitial(r.client_name))}</span>
          <div class="list-main">
            <strong>${escapeHTML(r.client_name)}</strong>
            <small>${dateBrief(r.session_date)} · ${String(r.start_time || '').slice(0, 5)} · ${escapeHTML(formatPhone(r.phone))} · ${escapeHTML(proximityText(r))}</small>
          </div>
          <span class="pill ${r.status}">${statuses[r.status] || r.status}</span>
          <button type="button" class="mini-btn" data-whatsapp="${r.id}">WhatsApp</button>
          <button type="button" class="mini-btn" data-edit="${r.id}">Editar</button>
        </div>
      `).join('')
      : '<div class="empty">Nenhum agendamento encontrado.</div>';
  }

  function renderFinance() {
    const items = records
      .filter(active)
      .sort((a, b) => (a.session_date + a.start_time).localeCompare(b.session_date + b.start_time));

    const total = items.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
    const paid = items.reduce((sum, r) => sum + Number(r.paid_amount || 0), 0);

    $('#finance-details').innerHTML = `
      <div class="list-row">
        <div class="list-main">
          <strong>Previsto: ${money(total)}</strong>
          <small>Recebido: ${money(paid)} · A receber: ${money(Math.max(0, total - paid))}</small>
        </div>
      </div>
    ` + (items.length
      ? items.map(r => `
        <div class="list-row">
          <span class="avatar">${escapeHTML(getInitial(r.client_name))}</span>
          <div class="list-main">
            <strong>${escapeHTML(r.client_name)}</strong>
            <small>${dateBrief(r.session_date)} · ${String(r.start_time || '').slice(0, 5)}</small>
          </div>
          <span class="money">${money(r.paid_amount)} / ${money(r.total_amount)}</span>
          <button type="button" class="mini-btn" data-edit="${r.id}">Editar</button>
        </div>
      `).join('')
      : '<div class="empty">Nenhuma reserva cadastrada.</div>');
  }

  function renderDayDashboard() {
    const now = rioNow();
    const today = records.filter(r => active(r) && r.session_date === now.date)
      .sort((a,b) => String(a.start_time).localeCompare(String(b.start_time)));
    const upcoming = records.filter(r => active(r) && minutesUntil(r) >= 0)
      .sort((a,b) => (a.session_date + a.start_time).localeCompare(b.session_date + b.start_time));
    const dayDate = new Date(`${now.date}T12:00:00Z`).toLocaleDateString('pt-BR', {
      timeZone:'UTC', weekday:'long', day:'2-digit', month:'long', year:'numeric'
    });
    $('#today-date-label').textContent = dayDate.toLocaleUpperCase('pt-BR');
    $('#today-heading').textContent = today.length
      ? `${today.length} ensaio${today.length > 1 ? 's' : ''} na agenda de hoje`
      : 'Seu dia no estúdio';
    $('#today-description').textContent = today.length
      ? 'Veja os horários e acompanhe quem está chegando.'
      : 'Sem ensaios marcados para hoje.';
    const next = upcoming[0];
    $('#next-session').innerHTML = next
      ? `<span>PRÓXIMO ENSAIO</span><strong>${escapeHTML(proximityText(next))}</strong><small>${escapeHTML(next.client_name)} · ${dateBrief(next.session_date)} às ${String(next.start_time).slice(0,5)}</small>`
      : '<span>PRÓXIMO ENSAIO</span><strong>Sem reservas futuras</strong><small>Novos atendimentos aparecerão aqui.</small>';
    const confirmed = today.filter(r => r.status === 'confirmado' || r.status === 'concluido').length;
    const pending = today.filter(r => r.status === 'pendente').length;
    const received = today.reduce((n,r)=>n+Number(r.paid_amount||0),0);
    $('#today-numbers').innerHTML = [
      ['Ensaios hoje', String(today.length).padStart(2,'0')],
      ['Confirmados / concluídos', String(confirmed).padStart(2,'0')],
      ['Aguardando sinal', String(pending).padStart(2,'0')],
      ['Recebido nos ensaios de hoje', money(received)]
    ].map(([name,value])=>`<div><span>${escapeHTML(name)}</span><strong>${escapeHTML(value)}</strong></div>`).join('');
    $('#today-schedule').innerHTML = !inRange(now.date)
      ? '<div class="empty-confirmation"><strong>Fora do período da campanha</strong><p>O calendário natalino vai de 02/12/2026 a 18/01/2027. Entre em Calendário para consultar ou cadastrar as reservas.</p></div>'
      : slotTimes.map(t => {
      const r = today.find(x => String(x.start_time).slice(0,5) === t);
      if (!r) return `<div class="today-item free"><time>${t}</time><div><strong>Disponível</strong><small>Sem atendimento neste horário</small></div><button type="button" class="quiet-link" data-new-today="${t}">Adicionar +</button></div>`;
      const tag = r.status === 'pendente' ? 'Aguardando sinal' : (r.status === 'concluido'?'Concluído':'Reservado');
      return `<div class="today-item booked"><time>${t}</time><div><strong>${escapeHTML(r.client_name)}</strong><small>${escapeHTML(r.subject_name || r.session_type)} · ${escapeHTML(tag)} · ${escapeHTML(proximityText(r))}</small></div><button type="button" class="mini-btn" data-whatsapp="${r.id}">WhatsApp</button><button type="button" class="mini-btn" data-edit="${r.id}">Editar</button></div>`;
    }).join('');
    const tomorrow = records.filter(isTomorrow);
    const pendingContact = tomorrow.filter(r => !['confirmado','nao_confirmado'].includes(r.attendance_status || 'pendente')).length;
    $('#tomorrow-teaser-text').textContent = tomorrow.length
      ? `${tomorrow.length} ensaio${tomorrow.length!==1?'s':''} amanhã · ${pendingContact} aguardando resposta ou confirmação.`
      : 'Nenhum ensaio marcado para amanhã.';
    $('#upcoming-list').innerHTML = upcoming.length
      ? upcoming.slice(0,4).map(r => `<div class="upcoming-item"><span>${dateBrief(r.session_date)}<small>${String(r.start_time).slice(0,5)}</small></span><div><strong>${escapeHTML(r.client_name)}</strong><small>${escapeHTML(proximityText(r))}</small></div></div>`).join('')
      : '<p class="empty-lite">Nenhum próximo ensaio.</p>';
  }

  function renderConfirmationDashboard() {
    const date = shiftDate(rioNow().date, 1);
    const appointments = records.filter(isTomorrow)
      .sort((a,b)=>String(a.start_time).localeCompare(String(b.start_time)));
    const confirmations = appointments.filter(r=>(r.attendance_status||'pendente')==='confirmado').length;
    const sent = appointments.filter(r=>(r.attendance_status||'pendente')==='enviado').length;
    $('#confirmation-date').textContent = `${formatFullDate(date)} · Lista de clientes com ensaio amanhã.`;
    $('#tomorrow-summary').innerHTML = `<strong>${appointments.length} reserva${appointments.length!==1?'s':''}</strong><span>${confirmations} confirmada${confirmations!==1?'s':''} · ${sent} mensagem${sent!==1?'s':''} enviada${sent!==1?'s':''}</span>`;
    $('#confirmation-list').innerHTML = appointments.length
      ? appointments.map(r => {
        const status = r.attendance_status || 'pendente';
        return `<article class="confirmation-row">
          <div class="confirmation-time">${String(r.start_time).slice(0,5)}<span>AMANHÃ</span></div>
          <div class="confirmation-person"><strong>${escapeHTML(r.client_name)}</strong><small>${escapeHTML(formatPhone(r.phone))}${r.subject_name ? ' · '+escapeHTML(r.subject_name) : ''}</small><span class="contact-state ${escapeHTML(status)}">${escapeHTML(attendanceLabel(status))}</span></div>
          <div class="confirmation-actions">
            <button type="button" class="primary-btn" data-whatsapp="${r.id}">Abrir WhatsApp ↗</button>
            <button type="button" class="outline-btn ${status==='enviado'?'is-on':''}" data-attendance="enviado" data-attendance-id="${r.id}" ${status==='confirmado'?'disabled':''}>Mensagem enviada</button>
            <button type="button" class="outline-btn ${status==='confirmado'?'is-on':''}" data-attendance="confirmado" data-attendance-id="${r.id}">Confirmou presença</button>
            <button type="button" class="quiet-link" data-attendance="nao_confirmado" data-attendance-id="${r.id}">Não confirmou</button>
            <button type="button" class="quiet-link" data-attendance="pendente" data-attendance-id="${r.id}" ${status==='pendente'?'disabled':''}>Reiniciar</button>
          </div>
        </article>`;
      }).join('')
      : `<div class="empty-confirmation"><strong>Sem confirmações para amanhã</strong><p>Quando houver reservas para ${formatFullDate(date)}, elas aparecerão aqui para você entrar em contato.</p></div>`;
  }

  async function updateAttendanceStatus(id,status) {
    const r=records.find(x=>x.id===id);
    if (!r || !['pendente','enviado','confirmado','nao_confirmado'].includes(status)) return;
    const changes={attendance_status: status};
    if (status==='enviado') changes.reminder_sent_at=new Date().toISOString();
    if (status==='pendente') changes.reminder_sent_at=null;
    const { error } = await db.from('appointments').update(changes).eq('id',id);
    if (error) {
      alertMsg('Não foi possível registrar a confirmação. Execute primeiro o arquivo atualizar-banco.sql no Supabase. Detalhes: '+error.message);
      return;
    }
    await load();
  }

  function render() {
    renderStats();
    renderDayDashboard();
    renderConfirmationDashboard();
    renderCalendar();
    renderClients();
    renderFinance();
  }

  async function load() {
    const token = ++loadToken;
    const { data, error } = await db
      .from('appointments')
      .select('*')
      .order('session_date', { ascending: true })
      .order('start_time', { ascending: true });

    if (token !== loadToken) return;

    if (error) {
      setSync('Falha na sincronização');
      alertMsg('Não foi possível carregar a agenda: ' + error.message);
      return;
    }

    records = data || [];
    setSync('Sincronizado', true);
    alertMsg('', false);
    render();
  }

  async function saveAppointment(ev) {
    ev.preventDefault();
    const f = ev.currentTarget;
    const v = Object.fromEntries(new FormData(f).entries());

    v.client_name = v.client_name.trim();
    v.phone = cleanPhone(v.phone);
    v.subject_name = v.subject_name.trim();
    v.clothing_size = (v.clothing_size || '').trim();
    v.notes = v.notes.trim();
    v.total_amount = Number(v.total_amount);
    v.paid_amount = Number(v.paid_amount);

    const invalidNumbers = Number.isNaN(v.total_amount) || Number.isNaN(v.paid_amount);

    if (
      !v.client_name ||
      !inRange(v.session_date) ||
      !slotTimes.includes(v.start_time) ||
      ![10, 11].includes(v.phone.length) ||
      !/^\d+$/.test(v.phone) ||
      invalidNumbers ||
      v.total_amount < 0 ||
      v.paid_amount < 0 ||
      v.paid_amount > v.total_amount
    ) {
      $('#form-error').textContent = 'Revise nome, telefone com DDD, data, horário e valores (recebido não pode ultrapassar o total).';
      $('#form-error').classList.remove('hidden');
      return;
    }

    if (!statuses[v.status]) return;

    const overlap = records.find(r =>
      r.id !== editId &&
      r.session_date === v.session_date &&
      String(r.start_time || '').slice(0, 5) === v.start_time &&
      active(r)
    );

    if (overlap && v.status !== 'cancelado') {
      $('#form-error').textContent = 'Este horário já está ocupado por ' + overlap.client_name + '.';
      $('#form-error').classList.remove('hidden');
      return;
    }

    $('#save-btn').disabled = true;
    $('#form-error').classList.add('hidden');

    let result;
    if (editId) {
      const previous = records.find(x => x.id === editId);
      if (previous && (previous.session_date !== v.session_date || String(previous.start_time).slice(0,5) !== v.start_time)) {
        v.attendance_status = 'pendente';
        v.reminder_sent_at = null;
      }
      result = await db.from('appointments').update(v).eq('id', editId);
    } else {
      result = await db.from('appointments').insert(v);
    }

    $('#save-btn').disabled = false;

    if (result.error) {
      if (result.error.code === '23505') {
        $('#form-error').textContent = 'Esse horário foi reservado em outro aparelho. Atualize e escolha outro.';
      } else if (result.error.code === '23514') {
        $('#form-error').textContent = 'O banco de dados ainda está restringindo o horário de 17h/18h. Atualize a regra de horário no Supabase.';
      } else {
        $('#form-error').textContent = result.error.message;
      }
      $('#form-error').classList.remove('hidden');
      await load();
      return;
    }

    selectedDate = v.session_date;
    month = v.session_date.slice(0, 7);
    closeModal();
    await load();
  }

  async function removeAppointment() {
    if (!editId) return;
    if (!confirm('Excluir definitivamente este ensaio? Esta ação não poderá ser desfeita. Prefira marcar como Cancelado para manter o histórico.')) return;

    $('#delete-btn').disabled = true;
    const { error } = await db.from('appointments').delete().eq('id', editId);
    $('#delete-btn').disabled = false;

    if (error) {
      $('#form-error').textContent = error.message;
      $('#form-error').classList.remove('hidden');
      return;
    }

    closeModal();
    await load();
  }

  function exportBackup() {
    const out = {
      app: 'Agenda Natalina — Marluce Souza Fotografia',
      version: 1,
      exported_at: new Date().toISOString(),
      appointments: records
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'backup-agenda-natalina-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function showApp() {
    display('app-content');
    await load();
  }

  async function init() {
    if (!configured) {
      display('setup-screen');
      return;
    }

    if (!window.supabase?.createClient) {
      alertMsg('Não foi possível conectar ao servidor do Supabase. Verifique sua internet e recarregue a página.');
      return;
    }

    db = window.supabase.createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });

    const { data: { session } } = await db.auth.getSession();
    if (session) await showApp();
    else display('login-screen');

    db.auth.onAuthStateChange((event, currentSession) => {
      if (event === 'SIGNED_OUT') {
        records = [];
        display('login-screen');
      } else if (event === 'SIGNED_IN' && currentSession && $('#app-content').classList.contains('hidden')) {
        setTimeout(showApp, 0);
      }
    });

    db.channel('agenda-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, () => load())
      .subscribe();

    setInterval(() => {
      if (!$('#app-content').classList.contains('hidden') && document.visibilityState === 'visible') {
        load();
      }
    }, 30000);
    setInterval(() => {
      if (!$('#app-content').classList.contains('hidden') && document.visibilityState === 'visible') {
        renderDayDashboard();
        renderConfirmationDashboard();
        if (currentView === 'agenda') renderSlots();
      }
    }, 60000);

    window.addEventListener('focus', () => {
      if (!$('#app-content').classList.contains('hidden')) load();
    });
  }

  $('#appointment-form').elements.phone.addEventListener('input', ev => {
    let d = ev.target.value.replace(/\D/g, '');
    if (d.startsWith('55') && d.length > 11) d = d.slice(2);
    if (d.startsWith('0') && d.length > 10) d = d.slice(1);
    d = d.slice(0, 11);

    if (d.length > 6) {
      ev.target.value = `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
    } else if (d.length > 2) {
      ev.target.value = `(${d.slice(0, 2)}) ${d.slice(2)}`;
    } else if (d.length > 0) {
      ev.target.value = `(${d}`;
    }
  });

  $('#login-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    $('#login-submit').disabled = true;
    $('#login-error').classList.add('hidden');

    const { error } = await db.auth.signInWithPassword({
      email: $('#login-email').value.trim(),
      password: $('#login-password').value
    });

    $('#login-submit').disabled = false;

    if (error) {
      $('#login-error').textContent = 'Não foi possível entrar. Verifique e-mail, senha e autorização.';
      $('#login-error').classList.remove('hidden');
    } else {
      await showApp();
    }
  });

  $('#logout').addEventListener('click', () => db?.auth.signOut());
  $('#add-btn').addEventListener('click', () => openModal());
  $('#appointment-form').addEventListener('submit', saveAppointment);
  $('#delete-btn').addEventListener('click', removeAppointment);
  $('#export-json').addEventListener('click', exportBackup);
  $('#search').addEventListener('input', renderClients);

  $('#prev-month').addEventListener('click', () => {
    month = '2026-12';
    selectedDate = '2026-12-02';
    renderCalendar();
  });

  $('#next-month').addEventListener('click', () => {
    month = '2027-01';
    selectedDate = '2027-01-01';
    renderCalendar();
  });

  document.addEventListener('click', e => {
    const close = e.target.closest('[data-close]');
    if (close) {
      closeModal();
      return;
    }

    const nav = e.target.closest('[data-view]');
    if (nav) {
      currentView = nav.dataset.view;
      document.querySelectorAll('.nav-btn').forEach(x => x.classList.toggle('active', x.dataset.view === currentView));
      for (const name of ['hoje', 'agenda', 'confirmacoes', 'clientes', 'financeiro']) {
        $('#' + name + '-view').classList.toggle('hidden', name !== currentView);
      }
      const titles = {
        hoje: ['Seu dia no estúdio', 'Agenda de trabalho · Natal 2026/27'],
        agenda: ['Calendário de ensaios', 'Dezembro e janeiro · horários das 10h às 18h'],
        confirmacoes: ['Confirmar amanhã', 'Lembretes individuais para os clientes do dia seguinte'],
        clientes: ['Clientes', 'Contatos e agendamentos da campanha'],
        financeiro: ['Financeiro', 'Sinais, recebimentos e valores pendentes']
      };
      $('#page-title').textContent = titles[currentView][0];
      $('#page-subtitle').textContent = titles[currentView][1];
      return;
    }

    const date = e.target.closest('[data-date]');
    if (date) {
      selectedDate = date.dataset.date;
      renderCalendar();
      return;
    }

    const daySlot = e.target.closest('[data-new-today]');
    if (daySlot) {
      const today = rioNow().date;
      if (!inRange(today)) {
        alertMsg('O dia atual está fora da campanha de Natal (02/12 a 18/01). Use o calendário para escolher uma data da campanha.');
        currentView = 'agenda';
        document.querySelectorAll('.nav-btn').forEach(x => x.classList.toggle('active',x.dataset.view==='agenda'));
        for (const name of ['hoje','agenda','confirmacoes','clientes','financeiro']) $('#'+name+'-view').classList.toggle('hidden',name!=='agenda');
        return;
      }
      selectedDate=today;
      month=today.slice(0,7);
      openModal(null,daySlot.dataset.newToday);
      return;
    }

    const attendanceBtn = e.target.closest('[data-attendance][data-attendance-id]');
    if (attendanceBtn) {
      updateAttendanceStatus(attendanceBtn.dataset.attendanceId, attendanceBtn.dataset.attendance);
      return;
    }

    const slot = e.target.closest('[data-new-slot]');
    if (slot) {
      openModal(null, slot.dataset.newSlot);
      return;
    }

    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const r = records.find(x => x.id === edit.dataset.edit);
      if (r) openModal(r);
      return;
    }

    const wa = e.target.closest('[data-whatsapp]');
    if (wa) {
      const r = records.find(x => x.id === wa.dataset.whatsapp);
      if (r) {
        window.open(whatsappLink(r.phone, messageFor(r)), '_blank', 'noopener,noreferrer');
      }
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && e.target.closest('[data-new-slot]')) {
      e.preventDefault();
      openModal(null, e.target.closest('[data-new-slot]').dataset.newSlot);
    }
  });

  init().catch(e => {
    display('setup-screen');
    console.error('Falha ao iniciar:', e);
  });
})();