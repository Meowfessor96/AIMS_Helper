document.addEventListener("DOMContentLoaded", async () => {
  // --- Persistent Storage Wrapper (STRICTLY Extension Storage) ---
  const storage = {
    get: (keys) => new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    }),
    set: (data) => new Promise((resolve) => {
      chrome.storage.local.set(data, () => resolve());
    })
  };

  // --- State Variables ---
  let { 
    aimsGpaData, aimsStudentData,
    courseOverrides, customCourseTypes, requiredCreditsConfig, customTypeOrder, suggestedCourseTypes 
  } = await storage.get([
    "aimsGpaData", "aimsStudentData",
    "courseOverrides", "customCourseTypes", "requiredCreditsConfig", "customTypeOrder", "suggestedCourseTypes"
  ]);

  courseOverrides = courseOverrides || {};
  customCourseTypes = customCourseTypes || [];
  requiredCreditsConfig = requiredCreditsConfig || {};
  customTypeOrder = customTypeOrder || [];
  suggestedCourseTypes = suggestedCourseTypes || {};
  aimsGpaData = aimsGpaData || [];

  let undoStack = [];
  let allCourses = [];
  let availableTypes = [];
  let degreeData = {};
  let creditSummaryByDegree = {};

  const gradePoints = { "A+": 10, "A": 10, "A-": 9, "B": 8, "B-": 7, "C": 6, "C-": 5, "D": 4, "P": 2, "U": 0, "F": 0, "W": 0, "I": 0 };
  const allowedGrades = ["", "A+", "A", "A-", "B", "B-", "C", "C-", "D", "P", "U", "F", "W", "I"];

  let selectedFilterTypes = null;
  let currentSortBy = "DEFAULT";

  function isTypeEnabled(type) {
    if (!selectedFilterTypes) return true;
    return selectedFilterTypes.has(type);
  }

  function isCheckboxCheckedInUI(type) {
    if (!selectedFilterTypes) return false;
    return selectedFilterTypes.has(type);
  }

  function syncSummaryCheckboxes() {
    document.querySelectorAll(".summary-type-filter-cb").forEach(cb => {
      cb.checked = isCheckboxCheckedInUI(cb.value);
    });
  }

  function isRegularSemester(semesterName) {
    if (!semesterName) return false;
    const s = String(semesterName).toLowerCase();
    if (s.includes("summer") || s.includes("vacation") || s.includes("winter") || s.includes("remedial")) {
      return false;
    }
    const monthMap = {
      jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
      may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
      sept: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
    };
    const parts = s.split(/[-–—\s]+/);
    let m1 = null, m2 = null;
    for (const p of parts) {
      if (monthMap[p]) {
        if (!m1) m1 = monthMap[p];
        else if (!m2) m2 = monthMap[p];
      }
    }
    if (m1 && m2) {
      const diff = (m2 - m1 + 12) % 12;
      if (diff < 3 || diff > 6) return false;
    }
    return true;
  }

  function updateFilterModalUI() {
    const container = document.getElementById("filter-types-checkbox-list");
    if (!container) return;
    container.innerHTML = "";

    availableTypes.forEach(t => {
      const isChecked = isCheckboxCheckedInUI(t);
      const label = document.createElement("label");
      label.className = "filter-checkbox-item";
      label.innerHTML = `
        <input type="checkbox" value="${t}" ${isChecked ? "checked" : ""} class="filter-type-cb" />
        <span>${t}</span>
      `;
      container.appendChild(label);
    });

    container.querySelectorAll(".filter-type-cb").forEach(cb => {
      cb.addEventListener("change", () => {
        if (!selectedFilterTypes) {
          selectedFilterTypes = new Set();
        }
        if (cb.checked) {
          selectedFilterTypes.add(cb.value);
        } else {
          selectedFilterTypes.delete(cb.value);
        }
        if (selectedFilterTypes.size === 0) {
          selectedFilterTypes = null;
        }
        syncSummaryCheckboxes();
        renderTable();
      });
    });
    syncSummaryCheckboxes();
  }

  // --- Data Processing ---
  async function processData() {
    allCourses = aimsGpaData.map(course => ({ ...course, ...(courseOverrides[`${course.courseCd}_${course.periodName}`] || {}) }));

    let extractedTypes = new Set(customCourseTypes);
    allCourses.forEach(c => { if(c.courseElectiveTypeDesc && c.courseElectiveTypeDesc !== "—") extractedTypes.add(c.courseElectiveTypeDesc.trim()); });
    
    // Sort logic respecting custom order
    let newTypes = Array.from(extractedTypes).filter(t => !customTypeOrder.includes(t)).sort();
    customTypeOrder = customTypeOrder.filter(t => extractedTypes.has(t)); 
    customTypeOrder.push(...newTypes); 
    availableTypes = [...customTypeOrder];
    
    await storage.set({ customTypeOrder }); 

    degreeData = {}; creditSummaryByDegree = {};

    allCourses.forEach((course) => {
      const degree = course.degreeName || "Unspecified Degree";
      const semester = course.periodName || "Unknown";

      if (!degreeData[degree]) {
        degreeData[degree] = { semesters: {}, totalGradePoints: 0, totalGradedCredits: 0, totalAllCredits: 0 };
        creditSummaryByDegree[degree] = {};
      }
      if (!degreeData[degree].semesters[semester]) {
        degreeData[degree].semesters[semester] = { courses: [], gradePoints: 0, gradedCredits: 0, allCredits: 0 };
      }

      const credits = parseFloat(course.credits) || 0;
      const grade = course.gradeDesc ? course.gradeDesc.trim().toUpperCase() : "";
      const points = gradePoints[grade] || 0;
      const type = course.courseElectiveTypeDesc ? course.courseElectiveTypeDesc.trim() : "Unspecified";

      const isAdditional = type === "Additional" || type.toLowerCase().includes("additional");
      degreeData[degree].semesters[semester].courses.push(course);
      if (!isAdditional) {
        degreeData[degree].semesters[semester].allCredits += credits;
        degreeData[degree].totalAllCredits += credits;
      }

      if ((points > 0 || grade === "D" || grade === "P" || grade === "F" || grade === "U") && !isAdditional) {
        degreeData[degree].semesters[semester].gradePoints += points * credits;
        degreeData[degree].semesters[semester].gradedCredits += credits;
        degreeData[degree].totalGradePoints += points * credits;
        degreeData[degree].totalGradedCredits += credits;
      }

      creditSummaryByDegree[degree][type] = (creditSummaryByDegree[degree][type] || 0) + credits;
    });

    const photoEl = document.getElementById("photo");
    if(aimsStudentData && aimsGpaData.length > 0) {
      document.getElementById("student-name").textContent = aimsStudentData.name || "Name not found";
      document.getElementById("rollno").textContent = aimsStudentData.rollno || "";
      document.getElementById("branch").textContent = aimsStudentData.branch || "";
      if (aimsStudentData.photo) {
        photoEl.src = aimsStudentData.photo;
        photoEl.style.display = 'block';
      }
    } else {
      document.getElementById("student-name").textContent = "No Data - Please open from AIMS portal";
      document.getElementById("rollno").textContent = "";
      document.getElementById("branch").textContent = "";
      photoEl.style.display = 'none';
      photoEl.src = "";
    }
    updateFilterModalUI();
  }

  // --- Push to Undo Stack ---
  function saveHistory() {
    undoStack.push(JSON.parse(JSON.stringify(courseOverrides)));
    if (undoStack.length > 50) undoStack.shift();
  }

  // --- Handlers ---
  async function handleEdit(e) {
    saveHistory();
    const { course, period, field } = e.target.dataset;
    const key = `${course}_${period}`;
    const value = e.target.value.trim();
    
    courseOverrides[key] = courseOverrides[key] || {};
    courseOverrides[key][field] = value;
    await storage.set({ courseOverrides });

    // Dynamic UI Updates (Without losing focus)
    if (field === 'gradeDesc') {
      e.target.className = `editable-input grade-badge ${!value ? 'ungraded' : 'graded'}`;
    }

    if (field === 'courseElectiveTypeDesc') {
      const suggestion = suggestedCourseTypes[course];
      const container = e.target.closest('div');
      let indicator = container.querySelector('.suggestion-indicator');
      
      // Update the star immediately
      if (suggestion && value !== suggestion) {
        if (!indicator) {
          indicator = document.createElement('span');
          indicator.className = 'hide-print suggestion-indicator';
          indicator.title = `Suggested: ${suggestion}`;
          indicator.style.cssText = 'color: #f59e0b; font-weight: bold; margin-left: 6px; cursor: help; font-size: 16px;';
          indicator.textContent = '*';
          container.appendChild(indicator);
        }
      } else {
        if (indicator) indicator.remove();
      }
    }

    await processData(); 
    updateHeaders(); 
    renderSummary();
  }

  async function handleTargetCreditsEdit(e) {
    const type = e.target.dataset.type;
    requiredCreditsConfig[type] = parseFloat(e.target.value) || 0;
    await storage.set({ requiredCreditsConfig });
    renderSummary();
  }

  document.getElementById("undoBtn").addEventListener("click", async () => {
    if (undoStack.length === 0) { alert("Nothing to undo."); return; }
    courseOverrides = undoStack.pop();
    await storage.set({ courseOverrides });
    await processData(); 
    renderTable(); 
    renderSummary();
  });

  // --- Apply All Suggestions ---
  document.getElementById("applySuggestionsBtn").addEventListener("click", async () => {
    if (Object.keys(suggestedCourseTypes).length === 0) {
      alert("There are no suggested courses in your Curriculum.");
      return;
    }

    saveHistory();
    let changesMade = 0;

    allCourses.forEach(course => {
      const currentType = String(course.courseElectiveTypeDesc || "").trim();
      const isProtected = currentType === "Additional" || currentType.toLowerCase().includes("additional") ||
                          currentType === "Audit" || currentType.toLowerCase().includes("audit");
      if (isProtected) {
        return;
      }

      const suggestion = suggestedCourseTypes[course.courseCd];
      if (suggestion) {
        const key = `${course.courseCd}_${course.periodName}`;
        courseOverrides[key] = courseOverrides[key] || {};
        
        // Only modify if it's currently different from the suggestion
        if (courseOverrides[key].courseElectiveTypeDesc !== suggestion) {
          courseOverrides[key].courseElectiveTypeDesc = suggestion;
          changesMade++;
        }
      }
    });

    if (changesMade > 0) {
      await storage.set({ courseOverrides });
      await processData(); // Force data to process before rendering
      renderTable();
      renderSummary();
    } else {
      alert("All suggestions are already applied.");
    }
  });

  document.getElementById("resetBtn").addEventListener("click", async () => {
    if (!confirm("Are you sure you want to reset all manual edits?")) return;
    saveHistory();
    courseOverrides = {};
    await storage.set({ courseOverrides });
    await processData(); 
    renderTable(); 
    renderSummary();
  });

  document.getElementById("clearAllBtn").addEventListener("click", async () => {
    if (!confirm("⚠️ WARNING: Are you sure you want to delete ALL data? This will permanently remove your data, all manual edits, configurations, and reset the page to a blank state. This CANNOT be undone.")) return;
    
    aimsGpaData = []; aimsStudentData = null; courseOverrides = {};
    customCourseTypes = []; requiredCreditsConfig = {}; customTypeOrder = [];
    suggestedCourseTypes = {}; undoStack = [];

    await storage.set({ aimsGpaData, aimsStudentData, courseOverrides, customCourseTypes, requiredCreditsConfig, customTypeOrder, suggestedCourseTypes });
    window.location.reload();
  });

  // --- Batch Config Import/Export ---
  document.getElementById("exportConfigBtn").addEventListener("click", () => {
    const currentSuggestions = {};
    allCourses.forEach(c => {
      const t = c.courseElectiveTypeDesc?.trim();
      if (t && t !== "—" && t !== "Unspecified") currentSuggestions[c.courseCd] = t;
    });

    const config = { 
      customCourseTypes, 
      requiredCreditsConfig, 
      customTypeOrder, 
      suggestedCourseTypes: currentSuggestions 
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], {type: "application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "AIMS_Batch_Curriculum.json";
    a.click();
  });

  document.getElementById("importConfigBtn").addEventListener("click", () => document.getElementById("import-config-file").click());
  document.getElementById("import-config-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const config = JSON.parse(ev.target.result);
        if(config.customCourseTypes) customCourseTypes = config.customCourseTypes;
        if(config.requiredCreditsConfig) requiredCreditsConfig = config.requiredCreditsConfig;
        if(config.customTypeOrder) customTypeOrder = config.customTypeOrder;
        if(config.suggestedCourseTypes) suggestedCourseTypes = config.suggestedCourseTypes;
        await storage.set({ customCourseTypes, requiredCreditsConfig, customTypeOrder, suggestedCourseTypes });
        window.location.reload();
      } catch(err) { alert("Invalid Curriculum file."); }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  // --- Table Rendering ---
  function renderTable() {
    const tbody = document.getElementById("courses");
    tbody.innerHTML = "";
    if (allCourses.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 30px; color: #6b7280;">No data found. Please open this report via the AIMS Helper extension on your course history page.</td></tr>`;
      return;
    }

    Object.entries(degreeData).forEach(([degree, degreeInfo]) => {
      const totalRegularSems = Object.keys(degreeInfo.semesters).filter(s => isRegularSemester(s)).length;
      let currentSemNumber = totalRegularSems;
      Object.entries(degreeInfo.semesters).forEach(([semester, data]) => {
        let displaySemester = semester;
        if (isRegularSemester(semester)) {
          displaySemester = `Semester ${currentSemNumber} (${semester})`;
          currentSemNumber--;
        }

        const id = `header_${degree.replace(/\s+/g, '')}_${semester.replace(/[^a-zA-Z0-9]/g, '')}`;
        const headerRow = document.createElement("tr");
        headerRow.style.backgroundColor = "#f3f4f6";
        headerRow.innerHTML = `
         <td colspan="5" style="padding: 16px 20px; font-weight: 600;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span id="${id}">Loading...</span>
            <span>${degree}</span>
          </div>
        </td>`;
        tbody.appendChild(headerRow);

        let coursesToRender = [...data.courses];

        if (selectedFilterTypes && selectedFilterTypes.size < availableTypes.length) {
          coursesToRender = coursesToRender.filter(c => {
            const type = c.courseElectiveTypeDesc ? c.courseElectiveTypeDesc.trim() : "Unspecified";
            return selectedFilterTypes.has(type);
          });
        }

        if (currentSortBy === "CREDITS_DESC") {
          coursesToRender.sort((a, b) => (parseFloat(b.credits) || 0) - (parseFloat(a.credits) || 0));
        } else if (currentSortBy === "CREDITS_ASC") {
          coursesToRender.sort((a, b) => (parseFloat(a.credits) || 0) - (parseFloat(b.credits) || 0));
        } else if (currentSortBy === "GRADE_DESC") {
          coursesToRender.sort((a, b) => {
            const ga = a.gradeDesc ? a.gradeDesc.trim().toUpperCase() : "";
            const gb = b.gradeDesc ? b.gradeDesc.trim().toUpperCase() : "";
            const pa = gradePoints[ga] !== undefined ? gradePoints[ga] : -1;
            const pb = gradePoints[gb] !== undefined ? gradePoints[gb] : -1;
            return pb - pa;
          });
        } else if (currentSortBy === "GRADE_ASC") {
          coursesToRender.sort((a, b) => {
            const ga = a.gradeDesc ? a.gradeDesc.trim().toUpperCase() : "";
            const gb = b.gradeDesc ? b.gradeDesc.trim().toUpperCase() : "";
            const pa = gradePoints[ga] !== undefined ? gradePoints[ga] : -1;
            const pb = gradePoints[gb] !== undefined ? gradePoints[gb] : -1;
            return pa - pb;
          });
        }

        coursesToRender.forEach((course) => {
          const type = course.courseElectiveTypeDesc ? course.courseElectiveTypeDesc.trim() : "Unspecified";
          const grade = course.gradeDesc || "";
          const suggestion = suggestedCourseTypes[course.courseCd];
          const crsKey = `data-course="${course.courseCd}" data-period="${course.periodName}"`;

          // Construct Native Dropdown Optgroups
          let typeOpts = "";
          if (suggestion && availableTypes.includes(suggestion)) {
            typeOpts += `<optgroup label="Suggested">
                           <option value="${suggestion}" ${type === suggestion ? 'selected' : ''}>${suggestion}</option>
                         </optgroup>
                         <optgroup label="Other Types">`;
            availableTypes.forEach(t => {
              if (t !== suggestion) typeOpts += `<option value="${t}" ${type === t ? 'selected' : ''}>${t}</option>`;
            });
            typeOpts += `</optgroup>`;
          } else {
            availableTypes.forEach(t => {
              typeOpts += `<option value="${t}" ${type === t ? 'selected' : ''}>${t}</option>`;
            });
          }

          let indicator = "";
          if (suggestion && type !== suggestion) {
            indicator = `<span class="hide-print suggestion-indicator" title="Suggested: ${suggestion}" style="color: #f59e0b; font-weight: bold; margin-left: 6px; cursor: help; font-size: 16px;">*</span>`;
          }

          const gradeOpts = allowedGrades.map(g => `<option value="${g}" ${g === grade ? "selected" : ""}>${g || "—"}</option>`).join("");

          const row = document.createElement("tr");
          row.innerHTML = `
            <td><strong>${course.courseCd}</strong></td>
            <td>${course.courseName}</td>
            <td>
              <div style="display: flex; align-items: center; width: 100%;">
                <select class="editable-input type-select" style="flex: 1;" ${crsKey} data-field="courseElectiveTypeDesc">${typeOpts}</select>
                ${indicator}
              </div>
            </td>
            <td><input type="number" step="0.5" min="0" class="editable-input" value="${course.credits}" ${crsKey} data-field="credits" style="font-weight: 600;" /></td>
            <td><select class="editable-input grade-badge ${!grade.trim() ? 'ungraded' : 'graded'}" ${crsKey} data-field="gradeDesc">${gradeOpts}</select></td>
          `;
          tbody.appendChild(row);
        });
      });
    });

    document.querySelectorAll("#courses .editable-input").forEach(input => input.addEventListener("change", handleEdit));
    updateHeaders();
  }

  function updateHeaders() {
    Object.entries(degreeData).forEach(([degree, degreeInfo]) => {
      const totalRegularSems = Object.keys(degreeInfo.semesters).filter(s => isRegularSemester(s)).length;
      let currentSemNumber = totalRegularSems;
      Object.entries(degreeInfo.semesters).forEach(([semester, data]) => {
        let displaySemester = semester;
        if (isRegularSemester(semester)) {
          displaySemester = `Semester ${currentSemNumber} (${semester})`;
          currentSemNumber--;
        }
        const gpa = data.gradedCredits > 0 ? (data.gradePoints / data.gradedCredits).toFixed(2) : "0.00";
        const id = `header_${degree.replace(/\s+/g, '')}_${semester.replace(/[^a-zA-Z0-9]/g, '')}`;
        if (document.getElementById(id)) {
          document.getElementById(id).innerHTML = `${displaySemester} — <span style="background: #ffffff; border: 1px solid #e2e8f0; box-shadow: 0 0 10px rgba(255, 255, 255, 0.95), 0 1px 3px rgba(0,0,0,0.06); padding: 3px 10px; border-radius: 6px; font-weight: 600; color: #0f172a;">SGPA: ${gpa} (${data.allCredits.toFixed(1)} credits)</span>`;
        }
      });
    });
  }

  function renderSummary() {
    const summarySection = document.getElementById("summary-section");
    const summaryBody = document.getElementById("summary-body");
    
    if (allCourses.length === 0) { summarySection.style.display = "none"; return; }
    summarySection.style.display = "block";
    summaryBody.innerHTML = "";

    let totalAllCreditsSum = 0;
    let totalGradedCreditsSum = 0;
    let totalGradePointsSum = 0;
    Object.values(degreeData).forEach(d => {
      totalAllCreditsSum += d.totalAllCredits;
      totalGradedCreditsSum += d.totalGradedCredits;
      totalGradePointsSum += d.totalGradePoints;
    });
    const overallCgpa = totalGradedCreditsSum > 0 ? (totalGradePointsSum / totalGradedCreditsSum).toFixed(2) : "0.00";
    const topCgpaEl = document.getElementById("top-stat-cgpa");
    const topTotalEl = document.getElementById("top-stat-total-credits");
    const topGradedEl = document.getElementById("top-stat-graded-credits");
    if (topCgpaEl) topCgpaEl.textContent = overallCgpa;
    if (topTotalEl) topTotalEl.textContent = totalAllCreditsSum.toFixed(1);
    if (topGradedEl) topGradedEl.textContent = totalGradedCreditsSum.toFixed(1);

    Object.entries(degreeData).forEach(([degree, degreeInfo]) => {
      const cgpa = degreeInfo.totalGradedCredits > 0 ? (degreeInfo.totalGradePoints / degreeInfo.totalGradedCredits).toFixed(2) : "0.00";
      const totalTargetCredits = Object.values(requiredCreditsConfig).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
      const targetStr = totalTargetCredits > 0 ? ` <span style="font-size:13px; color:#4b5563; font-weight:500;">/ Target: ${totalTargetCredits.toFixed(1)}</span>` : "";

      summaryBody.innerHTML += `
        <tr><td colspan="4" style="font-weight: 700; padding: 12px 20px; background-color: #f1f5f9; color: #0f172a;">${degree}</td></tr>
        <tr><td>CGPA</td><td colspan="3"><strong>${cgpa}</strong></td></tr>
        <tr><td>Total Credits Registered</td><td colspan="3"><strong>${degreeInfo.totalAllCredits.toFixed(1)}</strong>${degreeInfo.totalGradedCredits === degreeInfo.totalAllCredits ? targetStr : ""}</td></tr>
      `;

      if (degreeInfo.totalGradedCredits !== degreeInfo.totalAllCredits) {
        summaryBody.innerHTML += `<tr><td>Graded Credits</td><td colspan="3"><strong>${degreeInfo.totalGradedCredits.toFixed(1)}</strong>${targetStr}</td></tr>`;
      }

      summaryBody.innerHTML += `<tr>
        <td style="padding: 10px 20px; font-size: 13px; color: #374151; font-weight: 600;">Credits by Course Type</td>
        <td style="padding: 10px 20px; font-size: 13px; color: #374151; font-weight: 600; text-align: right; width: 80px;">Earned</td>
        <td style="padding: 10px 20px; font-size: 13px; color: #374151; font-weight: 600; text-align: right; width: 80px;">Target</td>
        <td class="hide-print" style="padding: 10px 20px; font-size: 13px; color: #374151; font-weight: 600; text-align: center; width: 50px;"></td>
      </tr>`;
      
      availableTypes.forEach((type) => {
        const total = creditSummaryByDegree[degree][type] || 0;
        const req = requiredCreditsConfig[type] !== undefined ? requiredCreditsConfig[type] : "";
        const isChecked = isCheckboxCheckedInUI(type);
        
        summaryBody.innerHTML += `<tr class="type-row" draggable="true" data-type="${type}">
          <td style="display: flex; align-items: center; gap: 8px; font-weight: 400;">
            <span class="drag-handle hide-print">≡</span>
            <input type="checkbox" class="summary-type-filter-cb hide-print" value="${type}" ${isChecked ? "checked" : ""} style="width: 16px; height: 16px; accent-color: #a855f7; cursor: pointer;" title="Filter table by ${type}" />
            <span>${type}</span>
          </td>
          <td>${total.toFixed(1)}</td>
          <td><input type="number" step="0.5" min="0" class="editable-input target-credit-input" style="width: 60px; font-weight: 600; text-align: right; border: 1px solid #e5e7eb; border-radius: 4px; padding: 2px 4px;" data-type="${type}" value="${req}" placeholder="—" /></td>
          <td class="hide-print" style="text-align: center;">
            ${total === 0 ? `<button class="action-btn remove-type-btn" style="padding: 2px 6px; font-size: 11px; color: #dc2626; background: #fef2f2; border-color: #fecaca; min-width: 24px;" data-type="${type}" title="Remove Type">✖</button>` : ''}
          </td>
        </tr>`;
      });
    });

    document.querySelectorAll(".summary-type-filter-cb").forEach(cb => {
      cb.addEventListener("change", () => {
        if (!selectedFilterTypes) {
          selectedFilterTypes = new Set();
        }
        if (cb.checked) {
          selectedFilterTypes.add(cb.value);
        } else {
          selectedFilterTypes.delete(cb.value);
        }
        if (selectedFilterTypes.size === 0) {
          selectedFilterTypes = null;
        }
        updateFilterModalUI();
        syncSummaryCheckboxes();
        renderTable();
      });
    });

    document.querySelectorAll(".target-credit-input").forEach(input => input.addEventListener("change", handleTargetCreditsEdit));
    
    // Type Removal Logic
    document.querySelectorAll(".remove-type-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const typeToRemove = e.target.dataset.type;
        if(confirm(`Are you sure you want to completely remove the "${typeToRemove}" category?`)) {
          customCourseTypes = customCourseTypes.filter(t => t !== typeToRemove);
          customTypeOrder = customTypeOrder.filter(t => t !== typeToRemove);
          availableTypes = availableTypes.filter(t => t !== typeToRemove);
          delete requiredCreditsConfig[typeToRemove];

          let overridesChanged = false;
          Object.keys(courseOverrides).forEach(key => {
            if(courseOverrides[key].courseElectiveTypeDesc === typeToRemove) {
               delete courseOverrides[key].courseElectiveTypeDesc;
               overridesChanged = true;
            }
          });

          await storage.set({ customCourseTypes, customTypeOrder, requiredCreditsConfig });
          if(overridesChanged) await storage.set({ courseOverrides });

          await processData();
          renderTable();
          renderSummary();
        }
      });
    });

    attachDragAndDrop();
  }

  // --- Drag and Drop Logic ---
  function attachDragAndDrop() {
    const summaryBody = document.getElementById("summary-body");
    let draggedRow = null;

    summaryBody.querySelectorAll('.type-row').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        // Prevent drag on inputs/buttons
        if(e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') {
            e.preventDefault();
            return;
        }
        draggedRow = row;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => row.classList.add('dragging'), 0);
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!draggedRow || draggedRow === row) return;
        const bounding = row.getBoundingClientRect();
        const offset = bounding.y + (bounding.height / 2);
        row.classList.remove('drag-over-top', 'drag-over-bottom');
        if (e.clientY - offset > 0) row.classList.add('drag-over-bottom');
        else row.classList.add('drag-over-top');
      });

      row.addEventListener('dragleave', () => row.classList.remove('drag-over-top', 'drag-over-bottom'));

      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('drag-over-top', 'drag-over-bottom');
        if (!draggedRow || draggedRow === row) return;

        const bounding = row.getBoundingClientRect();
        const offset = bounding.y + (bounding.height / 2);
        if (e.clientY - offset > 0) row.after(draggedRow);
        else row.before(draggedRow);
        
        draggedRow.classList.remove('dragging');
        draggedRow = null;

        customTypeOrder = Array.from(summaryBody.querySelectorAll('.type-row')).map(r => r.dataset.type);
        availableTypes = [...customTypeOrder];
        await storage.set({ customTypeOrder });
        renderTable(); 
      });

      row.addEventListener('dragend', () => {
        if(draggedRow) draggedRow.classList.remove('dragging');
        summaryBody.querySelectorAll('.type-row').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
        draggedRow = null;
      });
    });
  }

  document.getElementById("add-type-btn").addEventListener("click", async () => {
    const input = document.getElementById("new-type-input");
    const newType = input.value.trim();
    if(newType && !availableTypes.includes(newType)) {
      availableTypes.push(newType); customCourseTypes.push(newType); customTypeOrder.push(newType);
      await storage.set({ customCourseTypes, customTypeOrder });
      document.querySelectorAll(".type-select").forEach(select => {
        const val = select.value;
        select.innerHTML = availableTypes.map(t => `<option value="${t}" ${t === val ? "selected" : ""}>${t}</option>`).join("");
      });
      input.value = "";
      if (selectedFilterTypes) selectedFilterTypes.add(newType);
      updateFilterModalUI();
      renderSummary();
    }
  });

  const filterSortBtn = document.getElementById("filterSortBtn");
  const filterSortOverlay = document.getElementById("filterSortOverlay");
  const filterSortClose = document.getElementById("filterSortClose");
  const filterApplyBtn = document.getElementById("filterApplyBtn");
  const selectAllBtn = document.getElementById("selectAllTypesBtn");
  const clearAllBtn = document.getElementById("clearAllTypesBtn");

  if (filterSortBtn && filterSortOverlay) {
    filterSortBtn.addEventListener("click", () => {
      updateFilterModalUI();
      filterSortOverlay.classList.add("open");
    });
  }
  const closeFilterModal = () => {
    if (filterSortOverlay) filterSortOverlay.classList.remove("open");
  };
  if (filterSortClose) filterSortClose.addEventListener("click", closeFilterModal);
  if (filterApplyBtn) filterApplyBtn.addEventListener("click", closeFilterModal);
  if (filterSortOverlay) {
    filterSortOverlay.addEventListener("click", (e) => {
      if (e.target === filterSortOverlay) closeFilterModal();
    });
  }
  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", () => {
      selectedFilterTypes = new Set(availableTypes);
      updateFilterModalUI();
      syncSummaryCheckboxes();
      renderTable();
    });
  }
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", () => {
      selectedFilterTypes = null;
      updateFilterModalUI();
      syncSummaryCheckboxes();
      renderTable();
    });
  }

  const sortSelectEl = document.getElementById("sort-by-select");
  if (sortSelectEl) {
    sortSelectEl.addEventListener("change", (e) => {
      currentSortBy = e.target.value;
      renderTable();
    });
  }

  // --- PDF Download Handling ---
  document.getElementById("downloadBtn").addEventListener("click", () => {
    const { jsPDF } = window.jspdf;
    const element = document.querySelector(".report");
    const bottomControls = document.getElementById("bottom-controls");
    const controlsBar = document.getElementById("controls-bar");
    const controlsBar2 = document.getElementById("controls-bar-2");
    const hiddenElements = element.querySelectorAll(".hide-print, input[type='checkbox'], button, .drag-handle, .remove-type-btn, .summary-type-filter-cb");
    const originalDisplays = new Map();
    hiddenElements.forEach(el => {
      originalDisplays.set(el, el.style.display);
      el.style.display = "none";
    });

    if(bottomControls) bottomControls.style.display = "none";
    if(controlsBar) controlsBar.style.display = "none";
    if(controlsBar2) controlsBar2.style.display = "none";

    const originalStyles = { boxShadow: element.style.boxShadow, borderRadius: element.style.borderRadius, overflow: element.style.overflow };
    element.style.boxShadow = "none"; element.style.borderRadius = "0"; element.style.overflow = "visible";
    const headerEl = element.querySelector('.header');
    const origHeaderOverflow = headerEl ? headerEl.style.overflow : "";
    if (headerEl) headerEl.style.overflow = "visible";

    const inputs = element.querySelectorAll('select.editable-input, input.editable-input');
    inputs.forEach(input => {
        const span = document.createElement('span');
        span.textContent = input.tagName === 'SELECT' ? (input.options[input.selectedIndex]?.text || "") : (input.value || "—");
        span.className = 'temp-pdf-span';
        
        const style = window.getComputedStyle(input);
        span.style.fontFamily = style.fontFamily; span.style.fontSize = style.fontSize;
        span.style.fontWeight = style.fontWeight; span.style.color = style.color; span.style.textAlign = style.textAlign;
        
        if(input.classList.contains('grade-badge')) {
           span.className = input.className + ' temp-pdf-span';
           span.style.padding = style.padding; span.style.backgroundColor = style.backgroundColor;
        }
        if(input.classList.contains('target-credit-input')) {
           span.style.border = 'none';
        }
        
        input.parentNode.insertBefore(span, input);
        input.style.display = 'none';
    });

    const doc = new jsPDF({ orientation: "p", unit: "pt", format: "a4" });
    const targetWidth = doc.internal.pageSize.getWidth();
    const scale = (targetWidth - 40) / 1040;
    doc.html(element, {
      callback: function (doc) {
        element.style.boxShadow = originalStyles.boxShadow; element.style.borderRadius = originalStyles.borderRadius; element.style.overflow = originalStyles.overflow;
        if (headerEl) headerEl.style.overflow = origHeaderOverflow;
        if(bottomControls) bottomControls.style.display = "flex";
        if(controlsBar) controlsBar.style.display = "flex";
        if(controlsBar2) controlsBar2.style.display = "flex";
        hiddenElements.forEach(el => {
          el.style.display = originalDisplays.get(el) || "";
        });

        document.querySelectorAll('.temp-pdf-span').forEach(span => span.remove());
        inputs.forEach(input => input.style.display = '');

        doc.save(`AIMS_GPA_Report_${aimsStudentData?.rollno || "Export"}.pdf`);
      },
      margin: [20, 20, 20, 20],
      html2canvas: { scale: scale, useCORS: true, scrollX: 0, scrollY: 0 },
      width: targetWidth,
      windowWidth: 1040,
      x: 0,
      y: 0
    });
  });

  await processData(); renderTable(); renderSummary();
});

// --- Help Modal ---
document.addEventListener("DOMContentLoaded", () => {
  const helpBtn = document.getElementById("helpBtn");
  const helpOverlay = document.getElementById("helpOverlay");
  const helpClose = document.getElementById("helpClose");
  if (helpBtn && helpOverlay && helpClose) {
    helpBtn.addEventListener("click", () => helpOverlay.classList.add("open"));
    helpClose.addEventListener("click", () => helpOverlay.classList.remove("open"));
    helpOverlay.addEventListener("click", (e) => { if (e.target === helpOverlay) helpOverlay.classList.remove("open"); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && helpOverlay.classList.contains("open")) helpOverlay.classList.remove("open"); });
  }
});