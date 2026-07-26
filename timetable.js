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
        updatePreview();
    });
});

async function scrapeTimetableData() {
    const allIcons = document.querySelectorAll('span.time_tab_icon');
    if (allIcons.length === 0) return [];

    const createScrapePromise = (icon) => {
        return new Promise((resolve) => {
            const parentRow = icon.closest('.formRowBlock');
            if (!parentRow) { resolve(null); return; }

            const courseCode = parentRow.querySelector('input[id^="cCd_"]')?.title || 'Unknown Code';
            const courseTitle = parentRow.querySelector('input[id^="cDesc_"]')?.title || 'Unknown Title';
            const fullTitle = `${courseCode}: ${courseTitle}`;

            const timetableDivId = icon.id.replace('timeTab_', 'tt_');
            const timetableDiv = document.getElementById(timetableDivId);

            if (!timetableDiv) { resolve({ title: fullTitle, schedule: [] }); return; }

            const observer = new MutationObserver(() => {
                let scheduleData = [];
                const tableRows = timetableDiv.querySelectorAll('tbody tr');

                if (tableRows.length > 0 && !tableRows[0].textContent.includes("No Time Table Available")) {
                    tableRows.forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length >= 3) {
                            try {
                                const content = cells[2].textContent.trim();
                                const parsed = JSON.parse(content);
                                scheduleData = scheduleData.concat(parsed);
                            } catch(e) {
                                scheduleData.push(cells[2].textContent.trim());
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
            const slot = parts[1];
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

function getSelectedCourses() {
    const selectedCourses = [];
    const checkboxes = document.querySelectorAll('.course-checkbox:checked');
    checkboxes.forEach(box => {
        const courseData = JSON.parse(box.dataset.courseData);
        const venue = box.closest('.course-item').querySelector('.venue-input').value;
        selectedCourses.push({ ...courseData, venue: venue });
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
            const endTime = slotParts[2].replace(/:/g, '');

            const firstEventDate = new Date(startDate);
            while (firstEventDate.toLocaleDateString('en-US', { weekday: 'long' }) !== dayOfWeek) {
                firstEventDate.setDate(firstEventDate.getDate() + 1);
            }
            
            const startYear = firstEventDate.getFullYear();
            const startMonth = (firstEventDate.getMonth() + 1).toString().padStart(2, '0');
            const startDay = firstEventDate.getDate().toString().padStart(2, '0');

            const untilDate = new Date(endDate);
            untilDate.setDate(untilDate.getDate() + 1);
            const untilYear = untilDate.getUTCFullYear();
            const untilMonth = (untilDate.getUTCMonth() + 1).toString().padStart(2, '0');
            const untilDay = untilDate.getUTCDate().toString().padStart(2, '0');

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

function displayCoursesForSelection(data) {
    const selectionDiv = document.getElementById('course-selection');
    const controls = document.getElementById('controls');
    const footer = document.getElementById('footer');
    selectionDiv.innerHTML = '';

    ensurePreviewContainer();

    let courseCounter = 0;
    data.forEach(course => {
        if (!course.schedule || course.schedule.length === 0) return;

        courseCounter++;
        const courseItem = document.createElement('div');
        courseItem.className = 'course-item';

        const labelGroup = document.createElement('div');
        labelGroup.className = 'course-label-group';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `course_${courseCounter}`;
        checkbox.className = 'course-checkbox';
        checkbox.dataset.courseData = JSON.stringify({ 
            title: course.title, 
            rawSchedule: course.schedule 
        });
        checkbox.checked = true;
        checkbox.addEventListener('change', updatePreview);

        const label = document.createElement('label');
        label.htmlFor = `course_${courseCounter}`;
        label.textContent = course.title;

        labelGroup.appendChild(checkbox);
        labelGroup.appendChild(label);
        
        const venueInput = document.createElement('input');
        venueInput.type = 'text';
        venueInput.className = 'venue-input';
        venueInput.placeholder = 'Venue...';
        venueInput.addEventListener('input', updatePreview);

        courseItem.appendChild(labelGroup);
        courseItem.appendChild(venueInput);
        selectionDiv.appendChild(courseItem);
    });
    
    if (courseCounter > 0) {
        controls.style.display = 'flex';
        footer.style.display = 'block';
        document.getElementById('selectAll').checked = true;
        updatePreview();
    } else {
        selectionDiv.textContent = 'Make sure you are on the course registration page.';
    }
}

function ensurePreviewContainer() {
    if (!document.getElementById('timetable-preview-container')) {
        const container = document.createElement('div');
        container.id = 'timetable-preview-container';
        container.style.display = 'none';
        container.style.margin = '15px 0';
        container.style.textAlign = 'center';

        const img = document.createElement('img');
        img.id = 'timetable-preview-img';
        img.style.maxWidth = '100%';
        img.style.maxHeight = '220px';
        img.style.cursor = 'pointer';
        img.style.border = '1px solid #ccc';
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
    const container = document.getElementById('timetable-preview-container');
    const img = document.getElementById('timetable-preview-img');

    if (selectedCourses.length === 0) {
        container.style.display = 'none';
        return;
    }

    const dataUrl = await generateTimetableImage(selectedCourses);
    img.src = dataUrl;
    container.style.display = 'block';
}

async function generateTimetableImage(selectedCourses) {
    const events = [];
    const isJsonFormat = selectedCourses.some(c => typeof c.rawSchedule[0] === 'object');
    
    selectedCourses.forEach(course => {
        if (!course.rawSchedule || !Array.isArray(course.rawSchedule)) return;
        const seenSlots = new Set();
        
        course.rawSchedule.forEach(slot => {
            let day, startTime, endTime, segName = "";
            
            if (isJsonFormat && typeof slot === 'object' && slot.slotPeriodCdDays) {
                const parts = slot.slotPeriodCdDays.split('-');
                if (parts.length < 3) return;
                day = parts[0];
                startTime = parts[1].replace(':', '') + '00';
                endTime = parts[2].replace(':', '') + '00';
                segName = slot.segName || "";
            } else if (!isJsonFormat && typeof slot === 'string') {
                const parts = slot.split('----');
                if (parts.length < 2) return;
                const timeParts = parts[1].split('-');
                day = timeParts[0];
                startTime = timeParts[1].replace(':', '') + '00';
                endTime = timeParts[2].replace(':', '') + '00';
            } else return;
            
            const uniqueKey = `${day}-${startTime}-${segName}`;
            if (!seenSlots.has(uniqueKey)) {
                seenSlots.add(uniqueKey);
                const daysMap = { "Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5 };
                if (daysMap[day]) {
                    events.push({
                        title: course.title,
                        location: course.venue,
                        dayIndex: daysMap[day],
                        startTime: startTime,
                        endTime: endTime,
                        segName: segName
                    });
                }
            }
        });
    });

    const hasLateCourses = events.some(ev => parseInt(ev.startTime) >= 180000);

    const columns = [
        { label: "9:00\n9:55", start: "090000", end: "095500" },
        { label: "10:00\n10:55", start: "100000", end: "105500" },
        { label: "11:00\n11:55", start: "110000", end: "115500" },
        { label: "12:00\n12:55", start: "120000", end: "125500" },
        { label: "12:55\n14:30", type: "break", text: "Lunch", width: 60 },
        { label: "14:30\n15:55", start: "143000", end: "155500" },
        { label: "16:00\n17:25", start: "160000", end: "172500" }
    ];

    if (hasLateCourses) {
        columns.push({ label: "", type: "break", text: "S\nN\nA\nC\nK\n\nB\nR\nE\nA\nK", width: 45 });
        columns.push({ label: "18.00\n19:25", start: "180000", end: "192500" });
        columns.push({ label: "19:30\n21.00", start: "193000", end: "210000" });
    }

    const slotMapping = {
        "1": { "090000": "A", "100000": "B", "110000": "C", "120000": "D", "143000": "P", "160000": "Q", "180000": "W", "193000": "X" },
        "2": { "090000": "D", "100000": "E", "110000": "F", "120000": "G", "143000": "R", "160000": "S", "180000": "Y", "193000": "Z" },
        "3": { "090000": "B", "100000": "C", "110000": "A", "120000": "G", "143000": "F", "160000": "Challenge\nLectures", "180000": "", "193000": "" },
        "4": { "090000": "C", "100000": "A", "110000": "B", "120000": "E", "143000": "Q", "160000": "P", "180000": "W", "193000": "X" },
        "5": { "090000": "E", "100000": "F", "110000": "D", "120000": "G", "143000": "S", "160000": "R", "180000": "Y", "193000": "Z" }
    };

    const slotColors = {
        "A": "#FFD1DC", "B": "#FFE5B4", "C": "#FFFFB5", "D": "#D4F0F0",
        "E": "#CCE2CB", "F": "#E8DFF5", "G": "#FCE1E4", "P": "#F3C5FF",
        "Q": "#E2F0CB", "R": "#FFDFBA", "S": "#CBAACB", "W": "#FF9AA2",
        "X": "#E2F0CB", "Y": "#B5EAD7", "Z": "#C7CEEA", "Challenge\nLectures": "#F0F0F0"
    };

    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const grid = Array.from({ length: 6 }, () => Array.from({ length: columns.length }, () => []));

    events.forEach(ev => {
        const colIndex = columns.findIndex(c => c.start === ev.startTime);
        if (colIndex !== -1) {
            grid[ev.dayIndex][colIndex].push(ev);
        }
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const scale = 2;
    const baseWidth = hasLateCourses ? 1500 : 1250;
    const baseHeight = 1000; 

    canvas.width = baseWidth * scale;
    canvas.height = baseHeight * scale;
    ctx.scale(scale, scale);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, baseWidth, baseHeight);

    const startX = 110;
    const startY = 90;
    const tableWidth = baseWidth - startX - 20;
    const tableHeight = baseHeight - startY - 20;
    
    // Fixed header height, remainder distributed to 5 days
    const headerHeight = 50; 
    const dayRowHeight = (tableHeight - headerHeight) / 5;
    
    let dynamicColsCount = columns.filter(c => !c.width).length;
    let fixedWidthTotal = columns.reduce((sum, c) => sum + (c.width || 0), 0);
    const defaultColWidth = (tableWidth - fixedWidthTotal) / dynamicColsCount;
    
    columns.forEach(c => {
        if (!c.width) c.width = defaultColWidth;
    });

    function drawText(text, x, y, w, h, font = "15px Arial", maxLines = 5) {
        if (!text) return;
        ctx.font = font;
        ctx.fillStyle = "#000000";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        
        const lines = text.split('\n');
        const lineHeight = parseInt(font.match(/\d+/)[0], 10) * 1.3;
        const textHeight = lines.length * lineHeight;
        const startYPos = y + (h / 2) - (textHeight / 2) + (lineHeight / 2);
        
        lines.forEach((line, i) => {
            if (i < maxLines) {
                ctx.fillText(line, x + w / 2, startYPos + (i * lineHeight), w - 8);
            }
        });
    }

    function drawMultiFontText(linesObj, x, y, w, h) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        
        let totalHeight = 0;
        linesObj.forEach(line => {
            const size = parseInt(line.font.match(/\d+/)[0], 10);
            line.lineHeight = size * 1.3;
            totalHeight += line.lineHeight;
        });
        
        let currentY = y + (h / 2) - (totalHeight / 2);
        
        linesObj.forEach(line => {
            ctx.font = line.font;
            ctx.fillStyle = line.color || "#000000";
            currentY += line.lineHeight / 2;
            ctx.fillText(line.text, x + w / 2, currentY, w - 8);
            currentY += line.lineHeight / 2;
        });
    }

    ctx.font = "bold 26px Arial";
    ctx.textAlign = "center";
    ctx.fillStyle = "#000000";
    ctx.fillText("TIMETABLE SLOT", baseWidth / 2, 50);

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;

    ctx.strokeRect(20, startY, startX - 20, headerHeight);
    let currentX = startX;
    columns.forEach(col => {
        ctx.strokeRect(currentX, startY, col.width, headerHeight);
        drawText(col.label, currentX, startY, col.width, headerHeight, "bold 15px Arial");
        currentX += col.width;
    });

    currentX = startX;
    columns.forEach(col => {
        if (col.type === "break") {
            ctx.strokeRect(currentX, startY + headerHeight, col.width, tableHeight - headerHeight);
            drawText(col.text, currentX, startY + headerHeight, col.width, tableHeight - headerHeight, "16px Arial");
        }
        currentX += col.width;
    });

    for (let dayIndex = 1; dayIndex <= 5; dayIndex++) {
        const currentY = startY + headerHeight + ((dayIndex - 1) * dayRowHeight);
        
        ctx.strokeRect(20, currentY, startX - 20, dayRowHeight);
        drawText(days[dayIndex - 1], 20, currentY, startX - 20, dayRowHeight, "bold 15px Arial");

        currentX = startX;
        for (let colIndex = 0; colIndex < columns.length; colIndex++) {
            const col = columns[colIndex];
            
            if (col.type !== "break") {
                const cellEvents = grid[dayIndex][colIndex];
                const slotName = slotMapping[dayIndex][col.start] || "";
                
                if (cellEvents.length === 0) {
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(currentX, currentY, col.width, dayRowHeight);
                    ctx.strokeRect(currentX, currentY, col.width, dayRowHeight);
                    drawText(slotName, currentX, currentY, col.width, dayRowHeight, "15px Arial");
                } else {
                    ctx.fillStyle = slotColors[slotName] || "#ffffff";
                    ctx.fillRect(currentX, currentY, col.width, dayRowHeight);
                    ctx.strokeRect(currentX, currentY, col.width, dayRowHeight);
                    drawText(slotName, currentX, currentY, col.width, 28, "bold 14px Arial");
                    
                    const segments = cellEvents.length;
                    const drawAreaHeight = dayRowHeight - 28; 
                    const segmentHeight = drawAreaHeight / segments;

                    for (let s = 0; s < segments; s++) {
                        const ev = cellEvents[s];
                        const segY = currentY + 28 + (s * segmentHeight);
                        
                        if (s > 0) {
                            ctx.beginPath();
                            ctx.moveTo(currentX, segY);
                            ctx.lineTo(currentX + col.width, segY);
                            ctx.stroke();
                        }

                        let linesObj = [];
                        if (ev.title) {
                            const parts = ev.title.split(':');
                            const code = parts[0].trim();
                            const name = parts.length > 1 ? parts.slice(1).join(':').trim() : "";
                            
                            if (name) linesObj.push({ text: name, font: "bold 15px Arial" });
                            linesObj.push({ text: code, font: "13px Arial" });
                        }

                        if (ev.segName) linesObj.push({ text: `(Seg ${ev.segName})`, font: "12px Arial" });
                        if (ev.location) linesObj.push({ text: ev.location, font: "12px Arial" });

                        drawMultiFontText(linesObj, currentX, segY, col.width, segmentHeight);
                    }
                }
            }
            currentX += col.width;
        }
    }

    return canvas.toDataURL('image/png');
}