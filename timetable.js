document.addEventListener('DOMContentLoaded', () => {
    const fetchBtn = document.getElementById('fetchCoursesBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const selectAll = document.getElementById('selectAll');
    const loader = document.getElementById('loader');
    const themeToggle = document.getElementById('theme-toggle');

    const applyTheme = (isDark) => {
        if (isDark) {
            document.body.classList.add('dark-mode');
            themeToggle.checked = true;
        } else {
            document.body.classList.remove('dark-mode');
            themeToggle.checked = false;
        }
    };

    const savedTheme = localStorage.getItem('theme');
    applyTheme(savedTheme !== 'light');

    themeToggle.addEventListener('change', () => {
        const isDark = themeToggle.checked;
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
        applyTheme(isDark);
    });

    fetchBtn.addEventListener('click', async () => {
        fetchBtn.style.display = 'none';
        
        const gradesBtn = document.getElementById('fetchGradesBtn');
        if (gradesBtn) gradesBtn.style.display = 'none';

        const feedbackBtn = document.getElementById('submitFeedbackBtn');
        if (feedbackBtn) feedbackBtn.style.display = 'none';
        
        const statusEl = document.getElementById('status');
        if (statusEl) statusEl.style.display = 'none';

        loader.style.display = 'flex';

        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: scrapeTimetableData,
        }, (injectionResults) => {
            loader.style.display = 'none';
            if (chrome.runtime.lastError || !injectionResults || !injectionResults[0].result) {
                document.getElementById('main-content').innerHTML = '<p style="color:red; text-align:center;">Error: Could not access this page.</p>';
                return;
            }
            displayCoursesForSelection(injectionResults[0].result);
        });
    });

    downloadBtn.addEventListener('click', () => {
        const selectedCourses = getSelectedCourses();
        if (selectedCourses.length === 0) {
            alert('Please select at least one course to download.');
            return;
        }

        const reminder = document.getElementById('reminderTime').value;
        const icsString = generateICSContent(selectedCourses, reminder);
        const blob = new Blob([icsString], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'course_schedule.ics';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });
    
    selectAll.addEventListener('change', (event) => {
        document.querySelectorAll('.course-checkbox').forEach(box => {
            box.checked = event.target.checked;
        });
        schedulePreviewUpdate();  // debounced
    });
});

// ── Scraper (injected into the AIMS page) ────────────────────────────────────

async function scrapeTimetableData() {
    const allIcons = document.querySelectorAll('span.time_tab_icon');
    if (allIcons.length === 0) return [];

    const createScrapePromise = (icon) => {
        return new Promise((resolve) => {
            const parentRow = icon.closest('.formRowBlock');
            if (!parentRow) { resolve(null); return; }

            const courseCode  = parentRow.querySelector('input[id^="cCd_"]')?.title  || 'Unknown Code';
            const courseTitle = parentRow.querySelector('input[id^="cDesc_"]')?.title || 'Unknown Title';
            const fullTitle   = `${courseCode}: ${courseTitle}`;

            const timetableDivId = icon.id.replace('timeTab_', 'tt_');
            const timetableDiv   = document.getElementById(timetableDivId);

            if (!timetableDiv) { resolve({ title: fullTitle, schedule: [] }); return; }

            const observer = new MutationObserver(() => {
                let scheduleData = [];
                const tableRows  = timetableDiv.querySelectorAll('tbody tr');

                if (tableRows.length > 0 && !tableRows[0].textContent.includes("No Time Table Available")) {
                    tableRows.forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length >= 3) {
                            try {
                                // Try JSON format first (cells[2] may contain full API response)
                                const content = cells[2].textContent.trim();
                                const parsed  = JSON.parse(content);
                                scheduleData  = scheduleData.concat(parsed);
                            } catch (e) {
                                // String format: cells[1]=segment, cells[2]="DD-MM-YYYY----Day-HH:MM-HH:MM"
                                const segName = cells[1]?.textContent.trim() || '';
                                const timing  = cells[2].textContent.trim();
                                // Append segName as a 3rd ---- field so generateTimetableImage can extract it
                                scheduleData.push(segName ? `${timing}----${segName}` : timing);
                            }
                        }
                    });
                }
                observer.disconnect();
                resolve({ title: fullTitle, schedule: scheduleData });
            });

            observer.observe(timetableDiv, { childList: true, subtree: true });
            icon.click();
            //icon.click();
        });
    };

    const scrapePromises = Array.from(allIcons).map(icon => createScrapePromise(icon));
    return Promise.all(scrapePromises).then(results => results.filter(Boolean));
}

// ── Debounced preview update ──────────────────────────────────────────────────
// Prevents the canvas from re-rendering on every keypress / checkbox click.
let previewDebounceTimer = null;
function schedulePreviewUpdate() {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => updatePreview(), 300);
}

// ── ICS schedule processing (unchanged) ──────────────────────────────────────

function processScheduleForICS(rawSchedule) {
    if (!rawSchedule || rawSchedule.length === 0) return null;
    const scheduleMap = new Map();
    
    const isJsonFormat = typeof rawSchedule[0] === 'object' && rawSchedule[0].slotPeriodCdDays;

    rawSchedule.forEach(item => {
        if (isJsonFormat) {
            const slot = item.slotPeriodCdDays;
            if (!scheduleMap.has(slot)) scheduleMap.set(slot, []);
            if (item.newFrmDt) {
                const [dd, mm, yyyy] = item.newFrmDt.split('-');
                scheduleMap.get(slot).push(new Date(`${yyyy}-${mm}-${dd}`));
            }
        } else {
            const parts = typeof item === 'string' ? item.split('----') : [];
            if (parts.length < 2) return;
            const dateStr = parts[0];
            const slot    = parts[1]; // parts[2] is segName — not needed for ICS
            if (!scheduleMap.has(slot)) scheduleMap.set(slot, []);
            scheduleMap.get(slot).push(new Date(dateStr.split('-').reverse().join('-')));
        }
    });

    const processed = [];
    for (const [slot, dates] of scheduleMap.entries()) {
        if (dates.length > 0) {
            dates.sort((a, b) => a - b);
            processed.push({ slot, startDate: dates[0], endDate: dates[dates.length - 1] });
        }
    }
    return processed;
}

// ── ICS helpers (unchanged) ───────────────────────────────────────────────────

function getSelectedCourses() {
    const selectedCourses = [];
    const checkboxes = document.querySelectorAll('.course-checkbox:checked');
    checkboxes.forEach(box => {
        const courseData = JSON.parse(box.dataset.courseData);
        const venue      = box.closest('.course-item').querySelector('.venue-input').value;
        selectedCourses.push({ ...courseData, venue });
    });
    return selectedCourses;
}

function generateICSContent(selectedCourses, reminder) {
    const dayToICal = { 'Monday': 'MO', 'Tuesday': 'TU', 'Wednesday': 'WE', 'Thursday': 'TH', 'Friday': 'FR', 'Saturday': 'SA', 'Sunday': 'SU' };
    
    let icsContent = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Your Extension//AIMS Timetable Exporter//EN\r\nBEGIN:VTIMEZONE\r\nTZID:Asia/Kolkata\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nTZNAME:IST\r\nDTSTART:19700101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n`;

    selectedCourses.forEach(course => {
        const processedICS = processScheduleForICS(course.rawSchedule);
        if (!processedICS) return;

        processedICS.forEach(item => {
            const { slot, startDate, endDate } = item;
            const slotParts = slot.split('-');
            if (slotParts.length < 3) return;

            const dayOfWeek = slotParts[0];
            const startTime = slotParts[1].replace(/:/g, '');
            const endTime   = slotParts[2].replace(/:/g, '');

            const firstEventDate = new Date(startDate);
            while (firstEventDate.toLocaleDateString('en-US', { weekday: 'long' }) !== dayOfWeek) {
                firstEventDate.setDate(firstEventDate.getDate() + 1);
            }
            
            const startYear  = firstEventDate.getFullYear();
            const startMonth = (firstEventDate.getMonth() + 1).toString().padStart(2, '0');
            const startDay   = firstEventDate.getDate().toString().padStart(2, '0');

            const untilDate  = new Date(endDate);
            untilDate.setDate(untilDate.getDate() + 1);
            const untilYear  = untilDate.getUTCFullYear();
            const untilMonth = (untilDate.getUTCMonth() + 1).toString().padStart(2, '0');
            const untilDay   = untilDate.getUTCDate().toString().padStart(2, '0');

            const uid = `${startYear}${startMonth}${startDay}T${startTime}00-${Math.random().toString(36).substr(2, 9)}@aims.exporter`;
            
            icsContent += `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${new Date().toISOString().replace(/[-:.]/g, '')}Z\r\nSUMMARY:${course.title}\r\n`;
            icsContent += `DTSTART;TZID=Asia/Kolkata:${startYear}${startMonth}${startDay}T${startTime}00\r\n`;
            icsContent += `DTEND;TZID=Asia/Kolkata:${startYear}${startMonth}${startDay}T${endTime}00\r\n`;
            icsContent += `RRULE:FREQ=WEEKLY;UNTIL=${untilYear}${untilMonth}${untilDay}T000000Z;BYDAY=${dayToICal[dayOfWeek]}\r\n`;
            
            if (course.venue) icsContent += `LOCATION:${course.venue}\r\n`;
            
            if (reminder !== 'none') {
                icsContent += `BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT${reminder}\r\nEND:VALARM\r\n`;
            }
            icsContent += `END:VEVENT\r\n`;
        });
    });

    return icsContent + 'END:VCALENDAR';
}

// ── Course selection UI (unchanged) ───────────────────────────────────────────

function displayCoursesForSelection(data) {
    const selectionDiv = document.getElementById('course-selection');
    const controls     = document.getElementById('controls');
    const footer       = document.getElementById('footer');
    selectionDiv.innerHTML = '';

    ensurePreviewContainer();

    let courseCounter = 0;
    data.forEach(course => {
        // REMOVED: if (!course.schedule || course.schedule.length === 0) return;

        courseCounter++;
        const courseItem     = document.createElement('div');
        courseItem.className = 'course-item';

        const labelGroup     = document.createElement('div');
        labelGroup.className = 'course-label-group';

        const checkbox       = document.createElement('input');
        checkbox.type        = 'checkbox';
        checkbox.id          = `course_${courseCounter}`;
        checkbox.className   = 'course-checkbox';
        // Pass empty arrays cleanly
        checkbox.dataset.courseData = JSON.stringify({ title: course.title, rawSchedule: course.schedule || [] });
        checkbox.checked     = true;
        checkbox.addEventListener('change', schedulePreviewUpdate);

        const label      = document.createElement('label');
        label.htmlFor    = `course_${courseCounter}`;
        label.textContent = course.title;

        labelGroup.appendChild(checkbox);
        labelGroup.appendChild(label);
        
        const venueInput       = document.createElement('input');
        venueInput.type        = 'text';
        venueInput.className   = 'venue-input';
        venueInput.placeholder = 'Venue...';
        venueInput.addEventListener('input', schedulePreviewUpdate);

        courseItem.appendChild(labelGroup);
        courseItem.appendChild(venueInput);
        selectionDiv.appendChild(courseItem);
    });
    
    if (courseCounter > 0) {
        controls.style.display = 'flex';
        footer.style.display   = 'block';
        document.getElementById('selectAll').checked = true;
        updatePreview();
    } else {
        selectionDiv.textContent = 'Make sure you are on the course registration page.';
    }
}

function ensurePreviewContainer() {
    if (!document.getElementById('timetable-preview-container')) {
        const container  = document.createElement('div');
        container.id     = 'timetable-preview-container';
        container.style.display    = 'none';
        container.style.margin     = '15px 0';
        container.style.textAlign  = 'center';

        const img  = document.createElement('img');
        img.id     = 'timetable-preview-img';
        img.style.maxWidth    = '100%';
        img.style.maxHeight   = '220px';
        img.style.cursor      = 'pointer';
        img.style.border      = '1px solid #ccc';
        img.style.borderRadius = '4px';
        img.title = 'Click to open generated timetable in full size';

        img.addEventListener('click', () => {
            const newTab = window.open();
            if (newTab) {
                newTab.document.write(`<body style="margin:0;display:flex;align-items:center;justify-content:center;background:#222;min-height:100vh;"><img src="${img.src}" style="max-width:100%;max-height:100vh;background:white;border-radius:4px;"/></body>`);
                newTab.document.close();
            }
        });

        container.appendChild(img);
        const courseSelection = document.getElementById('course-selection');
        courseSelection.parentNode.insertBefore(container, courseSelection);
    }
}

async function updatePreview() {
    const selectedCourses = getSelectedCourses();
    const container       = document.getElementById('timetable-preview-container');
    const img             = document.getElementById('timetable-preview-img');

    if (selectedCourses.length === 0) {
        container.style.display = 'none';
        return;
    }

    const dataUrl = await generateTimetableImage(selectedCourses);
    img.src       = dataUrl;
    container.style.display = 'block';
}

// ── Timetable image generator ─────────────────────────────────────────────────

async function generateTimetableImage(selectedCourses) {

    // ── Column definitions ────────────────────────────────────────────────────
    const BASE_COLUMNS = [
        { label: "9:00\n9:55",   start: "090000", end: "095500", startMins: 540, endMins: 595  },
        { label: "10:00\n10:55", start: "100000", end: "105500", startMins: 600, endMins: 655  },
        { label: "11:00\n11:55", start: "110000", end: "115500", startMins: 660, endMins: 715  },
        { label: "12:00\n12:55", start: "120000", end: "125500", startMins: 720, endMins: 775  },
        { label: "12:55\n14:30", type: "break",  text: "Lunch", width: 60                      },
        { label: "14:30\n15:55", start: "143000", end: "155500", startMins: 870, endMins: 955  },
        { label: "16:00\n17:25", start: "160000", end: "172500", startMins: 960, endMins: 1045 },
    ];
    const LATE_COLUMNS = [
        { label: "", type: "break", text: "S\nN\nA\nC\nK\n\nB\nR\nE\nA\nK", width: 45           },
        { label: "18:00\n19:25", start: "180000", end: "192500", startMins: 1080, endMins: 1165 },
        { label: "19:30\n21:00", start: "193000", end: "210000", startMins: 1170, endMins: 1260 },
    ];

    const allColStartDefs = [...BASE_COLUMNS, ...LATE_COLUMNS]
        .filter(c => !c.type)
        .map(c => ({ key: c.start, mins: c.startMins }));

    // ── Time helpers ──────────────────────────────────────────────────────────
    function timeStrToKey(timeStr) {
        if (!timeStr || !timeStr.includes(':')) return null;
        const [hh, mm] = timeStr.split(':').map(Number);
        if (isNaN(hh)) return null;
        const mins = hh * 60 + (mm || 0);
        const SNAP = 5;
        let bestKey = null, bestDist = SNAP + 1;
        for (const cs of allColStartDefs) {
            const d = Math.abs(mins - cs.mins);
            if (d <= SNAP && d < bestDist) { bestDist = d; bestKey = cs.key; }
        }
        return bestKey || `${hh.toString().padStart(2,'0')}${(mm||0).toString().padStart(2,'0')}00`;
    }

    function keyToMins(key) {
        return parseInt(key.slice(0, 2), 10) * 60 + parseInt(key.slice(2, 4), 10);
    }

    // ── Process events ────────────────────────────────────────────────────────
    const isJsonFormat = selectedCourses.some(c =>
        Array.isArray(c.rawSchedule) &&
        typeof c.rawSchedule[0] === 'object' &&
        c.rawSchedule[0]?.slotPeriodCdDays
    );

    const DAYS_MAP = { "Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6, "Sunday": 7 };

    const events         = [];
    const overflowSeen   = new Set();
    const overflowCourses = [];

    function addOverflow(title, timing) {
        const k = title + '|' + (timing || '');
        if (!overflowSeen.has(k)) {
            overflowSeen.add(k);
            overflowCourses.push({ shortTitle: title.split(':')[0].trim(), fullTitle: title, timing });
        }
    }

    selectedCourses.forEach(course => {
        if (!course.rawSchedule || !Array.isArray(course.rawSchedule) || course.rawSchedule.length === 0) {
            addOverflow(course.title, null);
            return;
        }

        const seenSlots = new Set();

        course.rawSchedule.forEach(slot => {
            let day, startTimeStr, endTimeStr, segName = "";

            if (isJsonFormat && typeof slot === 'object' && slot?.slotPeriodCdDays) {
                const parts = slot.slotPeriodCdDays.split('-');
                if (parts.length < 3) return;
                day          = parts[0];
                startTimeStr = parts[1];
                endTimeStr   = parts[2];
                segName      = slot.segName || "";
            } else if (!isJsonFormat && typeof slot === 'string') {
                const parts = slot.split('----');
                if (parts.length < 2) return;
                const timeParts = parts[1].split('-');
                if (timeParts.length < 3) return;
                day          = timeParts[0];
                startTimeStr = timeParts[1];
                endTimeStr   = timeParts[2];
                segName      = parts[2] || '';
            } else return;

            if (!day || !startTimeStr) return;

            const startKey = timeStrToKey(startTimeStr);
            const endKey   = timeStrToKey(endTimeStr) || startKey;
            if (!startKey) return;

            const uniqueKey = `${day}-${startKey}-${segName}`;
            if (seenSlots.has(uniqueKey)) return;
            seenSlots.add(uniqueKey);

            const dayIndex = DAYS_MAP[day];
            if (!dayIndex) {
                addOverflow(course.title, `${day} ${startTimeStr}–${endTimeStr}`);
                return;
            }

            events.push({ title: course.title, location: course.venue || "", dayIndex, startKey, endKey, segName });
        });
    });

    // ── Determine layout ──────────────────────────────────────────────────────
    const hasLateCourses = events.some(ev => parseInt(ev.startKey) >= 180000);
    const hasSaturday    = events.some(ev => ev.dayIndex === 6);
    const hasSunday      = events.some(ev => ev.dayIndex === 7);
    const hasOverflow    = overflowCourses.length > 0;

    const columns = [...BASE_COLUMNS];
    if (hasLateCourses) columns.push(...LATE_COLUMNS);

    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    if (hasSaturday) days.push("Saturday");
    if (hasSunday)   days.push("Sunday");
    const numDays = days.length;

    // ── Build grid with multi-slot colSpan ────────────────────────────────────
    function findCoveredColIndices(startKey, endKey) {
        const startM = keyToMins(startKey);
        const endM   = keyToMins(endKey);
        const covered = [];
        for (let i = 0; i < columns.length; i++) {
            const col = columns[i];
            if (col.type) continue; 
            if (startM < col.endMins && endM > col.startMins) covered.push(i);
        }
        return covered;
    }

    const grid = Array.from({ length: 8 }, () => Array.from({ length: columns.length }, () => null));

    events.forEach(ev => {
        const covered = findCoveredColIndices(ev.startKey, ev.endKey);
        if (covered.length === 0) {
            addOverflow(ev.title, `${ev.startKey}`);
            return;
        }
        const firstCol = covered[0];
        const colSpan  = covered[covered.length - 1] - covered[0] + 1;
        if (!grid[ev.dayIndex][firstCol]) grid[ev.dayIndex][firstCol] = [];
        grid[ev.dayIndex][firstCol].push({ ...ev, colSpan });
    });

    // ── Pre-compute Consistent Course Colors ──────────────────────────────────
    const slotMapping = {
        "1": { "090000": "A", "100000": "B", "110000": "C", "120000": "D", "143000": "P", "160000": "Q", "180000": "W", "193000": "X" },
        "2": { "090000": "D", "100000": "E", "110000": "F", "120000": "G", "143000": "R", "160000": "S", "180000": "Y", "193000": "Z" },
        "3": { "090000": "B", "100000": "C", "110000": "A", "120000": "G", "143000": "F", "160000": "Challenge\nLectures", "180000": "", "193000": "" },
        "4": { "090000": "C", "100000": "A", "110000": "B", "120000": "E", "143000": "Q", "160000": "P", "180000": "W", "193000": "X" },
        "5": { "090000": "E", "100000": "F", "110000": "D", "120000": "G", "143000": "S", "160000": "R", "180000": "Y", "193000": "Z" },
    };
    const slotColors = {
        "A": "#FFD1DC", "B": "#FFE5B4", "C": "#FFFFB5", "D": "#D4F0F0",
        "E": "#CCE2CB", "F": "#E8DFF5", "G": "#FCE1E4", "P": "#F3C5FF",
        "Q": "#E2F0CB", "R": "#FFDFBA", "S": "#CBAACB", "W": "#FF9AA2",
        "X": "#E2F0CB", "Y": "#B5EAD7", "Z": "#C7CEEA", "Challenge\nLectures": "#F0F0F0",
    };

    const courseColors = {};
    
    events.forEach(ev => {
        const slotName = slotMapping[String(ev.dayIndex)]?.[ev.startKey] || "";
        if (slotColors[slotName] && !courseColors[ev.title]) {
            courseColors[ev.title] = slotColors[slotName];
        }
    });

    events.forEach(ev => {
        if (!courseColors[ev.title]) {
            courseColors[ev.title] = "#D4E6F1"; 
        }
    });

    // ── Canvas setup ──────────────────────────────────────────────────────────
    const scale        = 2;
    const timetableRightEdge = hasLateCourses ? 1500 : 1250;
    const overflowWidth = hasOverflow ? 350 : 0;
    const baseWidth    = timetableRightEdge + overflowWidth;
    const startX       = 110;
    const startY       = 90;
    const headerH      = 50;
    const dayRowH      = 160;
    const tableWidth   = timetableRightEdge - startX - 20;
    const tableHeight  = headerH + numDays * dayRowH;
    const baseHeight   = startY + tableHeight + 20; // Removed bottom overflow height calc

    const canvas  = document.createElement('canvas');
    const ctx     = canvas.getContext('2d');
    canvas.width  = baseWidth  * scale;
    canvas.height = baseHeight * scale;
    ctx.scale(scale, scale);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, baseWidth, baseHeight);

    const fixedWidthTotal  = columns.reduce((s, c) => s + (c.width || 0), 0);
    const dynamicColsCount = columns.filter(c => !c.width).length;
    const defaultColWidth  = dynamicColsCount > 0 ? (tableWidth - fixedWidthTotal) / dynamicColsCount : 0;
    columns.forEach(c => { if (!c.width) c.width = defaultColWidth; });

    // ── Canvas draw helpers ───────────────────────────────────────────────────
    function drawText(text, x, y, w, h, font = "15px Arial", maxLines = 5) {
        if (!text) return;
        ctx.font          = font;
        ctx.fillStyle     = "#000000";
        ctx.textAlign     = "center";
        ctx.textBaseline  = "middle";
        const lines       = text.split('\n');
        const lineHeight  = parseInt(font.match(/\d+/)[0], 10) * 1.3;
        const textHeight  = lines.length * lineHeight;
        const startYPos   = y + (h / 2) - (textHeight / 2) + (lineHeight / 2);
        lines.forEach((line, i) => {
            if (i < maxLines) ctx.fillText(line, x + w / 2, startYPos + (i * lineHeight), w - 8);
        });
    }

    function drawMultiFontText(linesObj, x, y, w, h) {
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        let totalHeight  = 0;
        linesObj.forEach(line => {
            const size     = parseInt(line.font.match(/\d+/)[0], 10);
            line.lineHeight = size * 1.3;
            totalHeight    += line.lineHeight;
        });
        let currentY = y + (h / 2) - (totalHeight / 2);
        linesObj.forEach(line => {
            ctx.font      = line.font;
            ctx.fillStyle = line.color || "#000000";
            currentY     += line.lineHeight / 2;
            ctx.fillText(line.text, x + w / 2, currentY, w - 8);
            currentY     += line.lineHeight / 2;
        });
    }

    // ── Draw title & Header ───────────────────────────────────────────────────
    ctx.font      = "bold 26px Arial";
    ctx.textAlign = "center";
    ctx.fillStyle = "#000000";
    ctx.fillText("TIMETABLE SLOT", timetableRightEdge / 2, 50);

    ctx.strokeStyle = "#000000";
    ctx.lineWidth   = 1;

    ctx.strokeRect(20, startY, startX - 20, headerH);
    let currentX = startX;
    columns.forEach(col => {
        ctx.fillStyle = '#ffffff'; 
        ctx.fillRect(currentX, startY, col.width, headerH);
        ctx.strokeRect(currentX, startY, col.width, headerH);
        drawText(col.label, currentX, startY, col.width, headerH, "bold 15px Arial");
        currentX += col.width;
    });

    // ── Draw break columns ────────────────────────────────────────────────────
    currentX = startX;
    columns.forEach(col => {
        if (col.type === "break") {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(currentX, startY + headerH, col.width, numDays * dayRowH);
            ctx.strokeRect(currentX, startY + headerH, col.width, numDays * dayRowH);
            drawText(col.text, currentX, startY + headerH, col.width, numDays * dayRowH, "16px Arial");
        }
        currentX += col.width;
    });

    // ── Draw each day row ─────────────────────────────────────────────────────
    for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
        const dayIndex = dayIdx + 1;                              
        const currentY = startY + headerH + (dayIdx * dayRowH);

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(20, currentY, startX - 20, dayRowH);
        ctx.strokeRect(20, currentY, startX - 20, dayRowH);
        drawText(days[dayIdx], 20, currentY, startX - 20, dayRowH, "bold 15px Arial");

        currentX = startX;
        let colIndex = 0;

        while (colIndex < columns.length) {
            const col = columns[colIndex];

            if (col.type === "break") {
                currentX += col.width;
                colIndex++;
                continue;
            }

            const cellEvents = grid[dayIndex][colIndex];
            const slotName   = slotMapping[String(dayIndex)]?.[col.start] || "";

            let drawnWidth = col.width;
            let colAdvance = 1;

            if (cellEvents && cellEvents.length > 0) {
                const maxSpan = Math.max(...cellEvents.map(ev => ev.colSpan || 1));
                if (maxSpan > 1) {
                    drawnWidth = 0;
                    let spanned = 0;
                    while (spanned < maxSpan && (colIndex + spanned) < columns.length) {
                        const sc = columns[colIndex + spanned];
                        if (sc.type === "break") break; 
                        drawnWidth += sc.width;
                        spanned++;
                    }
                    colAdvance = spanned;
                }
            }

            if (!cellEvents || cellEvents.length === 0) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(currentX, currentY, drawnWidth, dayRowH);
                ctx.strokeRect(currentX, currentY, drawnWidth, dayRowH);
                drawText(slotName, currentX, currentY, drawnWidth, dayRowH, "15px Arial");
            } else {
                cellEvents.sort((a, b) => {
                    const segA = parseInt((a.segName || '99').match(/\d+/) || ['99'], 10);
                    const segB = parseInt((b.segName || '99').match(/\d+/) || ['99'], 10);
                    return segA - segB;
                });

                ctx.fillStyle = courseColors[cellEvents[0].title] || "#D4E6F1";
                ctx.fillRect(currentX, currentY, drawnWidth, dayRowH);
                ctx.strokeRect(currentX, currentY, drawnWidth, dayRowH);

                drawText(slotName, currentX, currentY, drawnWidth, 28, "bold 14px Arial");

                const segments    = cellEvents.length;
                const drawAreaH   = dayRowH - 28;
                const segmentH    = drawAreaH / segments;

                for (let s = 0; s < segments; s++) {
                    const ev   = cellEvents[s];
                    const segY = currentY + 28 + (s * segmentH);

                    if (s > 0) {
                        ctx.beginPath();
                        ctx.moveTo(currentX,             segY);
                        ctx.lineTo(currentX + drawnWidth, segY);
                        ctx.stroke();
                    }

                    const linesObj = [];
                    if (ev.title) {
                        const parts = ev.title.split(':');
                        const code  = parts[0].trim();
                        const name  = parts.length > 1 ? parts.slice(1).join(':').trim() : "";
                        
                        if (name) {
                            ctx.font = "bold 15px Arial";
                            const maxWidth = drawnWidth - 10;
                            
                            if (ctx.measureText(name).width > maxWidth) {
                                const words = name.split(' ');
                                let line1 = '';
                                let i = 0;
                                
                                for (; i < words.length; i++) {
                                    const testLine = line1 + (line1 ? ' ' : '') + words[i];
                                    if (ctx.measureText(testLine).width > maxWidth && i > 0) break;
                                    line1 = testLine;
                                }
                                
                                let line2 = words.slice(i).join(' ');
                                if (line2 && ctx.measureText(line2).width > maxWidth) {
                                    let truncLine2 = '';
                                    let j = 0;
                                    const remainingWords = words.slice(i);
                                    for (; j < remainingWords.length; j++) {
                                        const testLine2 = truncLine2 + (truncLine2 ? ' ' : '') + remainingWords[j];
                                        if (ctx.measureText(testLine2 + '...').width > maxWidth && j > 0) break;
                                        truncLine2 = testLine2;
                                    }
                                    line2 = truncLine2 + '...';
                                }
                                
                                if (!line1) {
                                    line1 = words[0];
                                    line2 = words.slice(1).join(' ');
                                }

                                linesObj.push({ text: line1, font: "bold 15px Arial" });
                                if (line2) linesObj.push({ text: line2, font: "bold 15px Arial" });
                            } else {
                                linesObj.push({ text: name, font: "bold 15px Arial" });
                            }
                        }

                        const segSuffix = (ev.segName && ev.segName !== '1-6') ? ` (Seg ${ev.segName})` : '';
                        linesObj.push({ text: code + segSuffix, font: "13px Arial" });
                    }
                    
                    if (ev.location) linesObj.push({ text: ev.location, font: "12px Arial" });

                    drawMultiFontText(linesObj, currentX, segY, drawnWidth, segmentH);
                }
            }

            currentX  += drawnWidth;
            colIndex  += colAdvance;
        }
    }

    // ── Overflow section (Now on the Right) ───────────────────────────────────
    if (hasOverflow) {
        const ovStartX    = timetableRightEdge + 20;
        const ovStartY    = startY;
        
        ctx.font      = "bold 18px Arial";
        ctx.fillStyle = "#000000";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("Other Courses", ovStartX, ovStartY);
        ctx.font      = "14px Arial";
        ctx.fillStyle = "#555555";
        ctx.fillText("(No Schedule / Unmatched)", ovStartX, ovStartY + 22);

        let listY = ovStartY + 60;
        
        overflowCourses.forEach((oc) => {
            ctx.font = "bold 15px Arial";
            ctx.fillStyle = "#333333";
            
            // Handle text wrapping for long overflow titles
            const maxListWidth = overflowWidth - 40;
            const words = oc.fullTitle.split(' ');
            let line = '';
            const titleLines = [];
            
            for(let n = 0; n < words.length; n++) {
                const testLine = line + words[n] + ' ';
                if (ctx.measureText(testLine).width > maxListWidth && n > 0) {
                    titleLines.push(line);
                    line = words[n] + ' ';
                } else {
                    line = testLine;
                }
            }
            titleLines.push(line);
            
            titleLines.forEach((tLine, idx) => {
                const prefix = idx === 0 ? "• " : "  ";
                ctx.fillText(prefix + tLine.trim(), ovStartX, listY);
                listY += 20;
            });

            ctx.font = "13px Arial";
            ctx.fillStyle = "#666666";
            const info = oc.timing ? `Timing: ${oc.timing}` : 'No timings available';
            ctx.fillText(`  ${info}`, ovStartX, listY);
            
            listY += 25; // Space between items
        });
    }

    return canvas.toDataURL('image/png');
}