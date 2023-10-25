import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { createTooltip } from "../tooltips";
import { SidebarContext } from "../apps/BackOfficeApp";
import { firstLetterUppercase } from "../util";
import { graph } from "../pages/FeaturesPage";

export function DefaultSidebar(props) {
  const pathname = window.location.pathname;
  const rootClassName = (part) => {
    if (pathname.startsWith("/bo/dashboard/routes")) {
      if (
        pathname.startsWith("/bo/dashboard/routes/new") ||
        pathname === "/bo/dashboard/routes"
      ) {
        return pathname.startsWith(`/bo/dashboard/${part}`) ? "active" : "";
      } else {
        return "";
      }
    } else {
      return pathname.startsWith(`/bo/dashboard/${part}`) ? "active" : "";
    }
  };

  const clearSidebar = () => {
    if (props.setSidebarContent) props.setSidebarContent(null);
  };

  const [shortcuts, setShortcuts] = useState([]);
  const [hightlighted, setHighlighted] = useState();

  const [start, setStart] = useState({ clientY: 0 });
  const [client, setClient] = useState({ clientY: 0 });
  const [draggingIndex, setDraggingIndex] = useState(-1);

  useEffect(() => {
    reloadStorage()
  }, [])

  const reloadStorage = () => {
    setShortcuts(JSON.parse(localStorage.getItem('shortcuts') || "[]"))
  }

  const removeShortcut = shortcut => {
    const shortcuts = JSON.parse(localStorage.getItem('shortcuts') || "[]");

    const newShortcuts = shortcuts.filter(f => !f.includes(shortcut));
    localStorage.setItem('shortcuts', JSON.stringify(newShortcuts));

    reloadStorage();
  }

  const sortCategory = (a, b) => {
    const fa = a.title.toLowerCase(), fb = b.title.toLowerCase();

    if (fa < fb) {
      return -1;
    }
    if (fa > fb) {
      return 1;
    }
    return 0;
  }

  const setPosition = (offset) => {
    const index = Math.round(draggingIndex + offset)

    const item = shortcuts[draggingIndex];
    const b = shortcuts[index];

    let newShortcuts = [...shortcuts];
    newShortcuts[draggingIndex] = b;
    newShortcuts[index] = item;

    setDraggingIndex(index)
    setShortcuts(newShortcuts)
  }

  const sidebarContext = useContext(SidebarContext);
  const { openedSidebar } = sidebarContext;

  const links = graph(props.env);

  const features = links
    .flatMap(l => l.features.map(f => ({ ...f, title: f.title.toLowerCase() })))

  return <>
    <ul className="nav flex-column nav-sidebar"
      style={{
        opacity: !hightlighted ? 1 : .5,
      }}
      onMouseMove={ev => {
        if (!isNaN(draggingIndex) && draggingIndex !== -1) {
          if (start.clientY === 0) {
            setStart({ clientY: ev.clientY })
          } else {
            console.log(Math.floor(ev.clientY - start.clientY), Math.floor(ev.clientY - start.clientY) / 32)
            setClient({ clientY: ev.clientY })

            const offset = Math.floor(ev.clientY - start.clientY) / 32;

            if (offset < -1 || offset >= 1) {
              const index = Math.round(draggingIndex + offset)
              if (!(index < 0 || index > shortcuts.length - 1 || (index === draggingIndex))) {
                setStart({ clientY: ev.clientY })
                setPosition(offset)
              }
            }
          }
        }
      }}
      onMouseUp={() => {
        setTimeout(() => {
          setDraggingIndex(undefined)
          localStorage.setItem('shortcuts', JSON.stringify(shortcuts.filter(f => f)))
        }, 50) // delay to avoid simple click
      }}
    >
      {openedSidebar && <p className="ps-2">Shortcuts</p>}
      {shortcuts
        .map(shortcut => features.find(feat => feat.title.includes(shortcut)))
        .map((shortcut, initialIndex) => {
          return <SidebarLink
            key={shortcut.title}
            dragging={draggingIndex === initialIndex ? ({
              clientY: client.clientY - start.clientY,
            }) : undefined}
            startDragging={clientY => {
              setStart({ clientY })
              setDraggingIndex(initialIndex)
            }}
            removeShortcut={() => removeShortcut(shortcut.title)}
            rootClassName={rootClassName}
            openedSidebar={openedSidebar}
            clearSidebar={clearSidebar}
            {...shortcut}
          />
        })}
    </ul>
    {openedSidebar && <ul className="nav flex-column nav-sidebar me-2" style={{ marginTop: 20 }}>
      <p className="ps-2">Categories</p>
      <div className="d-flex flex-column">
        {links
          .sort(sortCategory)
          .map((item, i) => {
            return <Block
              key={item.title}
              {...item}
              first={i === 0}
              last={i === (links.length - 1)}
              reloadStorage={reloadStorage}
              hightlighted={!hightlighted || item.title === hightlighted}
              setHighlighted={() => setHighlighted(item.title)}
              onClose={() => setHighlighted(undefined)} />
          })}
      </div>

      <li className={`nav-item ${openedSidebar ? "nav-item--open" : ""} mt-3`} style={{
        opacity: !hightlighted ? 1 : .5
      }}>
        <Link
          to="/features"
          className={`nav-link ${rootClassName("features")} d-flex align-items-center`}
          {...createTooltip("All features")}
          onClick={clearSidebar}
        >
          <img
            className="icon-menu icon-svg"
            src="/assets/images/svgs/menu-icon.svg"
            style={{
              marginRight: openedSidebar ? "1em" : "",
            }}
          />
          <span style={{ marginTop: "4px" }}>
            {!openedSidebar ? "" : "Features"}
          </span>
        </Link>
      </li>
    </ul>}
  </>
}

function CustomIcon({ icon }) {
  const iconValue = icon ? (typeof icon === 'function' ? icon() : icon) : null;
  const className = _.isString(iconValue)
    ? iconValue.indexOf(' ') > -1
      ? iconValue
      : `fa ${iconValue}`
    : null;
  const zeIcon = iconValue ? _.isString(iconValue) ? <i className={className} /> : iconValue : null;

  return zeIcon;
}

function Block({ title, features, first, last, reloadStorage, hightlighted, setHighlighted, onClose }) {
  const [open, setOpen] = useState(false)

  return <div key={title} style={{
    background: 'var(--bg-color_level1)',
    borderTopLeftRadius: first ? 6 : 0,
    borderTopRightRadius: first ? 6 : 0,
    borderBottomLeftRadius: last ? 6 : 0,
    borderBottomRightRadius: last ? 6 : 0,
    cursor: 'pointer',
    marginBottom: 1,
    opacity: hightlighted ? 1 : .5,
  }} className="py-2" onClick={() => {
    if (!open === false) {
      onClose()
    } else {
      setHighlighted()
    }
    setOpen(!open)
  }}>
    <div className="d-flex justify-content-between align-items-center px-3" style={{ color: 'var(--text)' }}>
      {title}
      <i className="fas fa-chevron-down" />
    </div>

    {
      open && <div style={{ display: 'flex', flexDirection: 'column' }} className="mt-2">
        {features
          .filter((d) => d.display === undefined || d.display())
          .map(({
            title, link, icon,
          }) => {

            return <Link
              to={link}
              key={title}
              className="sidebar-feature p-3 py-1 mx-1"
              style={{
                height: 'initial',
                borderRadius: 6
              }}
              onClick={() => {
                const shortcuts = JSON.parse(localStorage.getItem('shortcuts') || "[]");
                localStorage.setItem("shortcuts", JSON.stringify([...new Set([...shortcuts, title.toLowerCase()])]))
                reloadStorage()
              }}>
              <CustomIcon icon={icon} />
              <span style={{
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis'
              }}>{title}</span>
            </Link>
          })}
      </div>
    }
  </div >
}

function SidebarLink({
  openedSidebar,
  clearSidebar,
  title,
  text,
  icon,
  rootClassName,
  removeShortcut,
  startDragging,
  dragging,
  ...props
}) {
  const path = props.path || props.link;

  return <li
    className={`nav-item mt-0 d-flex align-items-center ${openedSidebar ? "nav-item--open" : ""}`}
    draggable={false}
    style={{
      position: dragging ? 'asbolute' : 'relative',
      top: dragging ? dragging.clientY : 'initial',
      border: dragging ? '1px solid var(--bg-color_level3)' : '2px solid transparent',
      zIndex: dragging ? 100 : 1,
      background: dragging ? 'var(--bg-color_level1)' : 'inherit'
    }}>
    <i className="fas fa-grip-vertical nav-item-eye d-flex align-items-center m-0"
      onMouseDown={e => {
        startDragging(e.clientY)
      }}
      style={{
        position: 'absolute',
        top: 0,
        left: 6,
        bottom: 0
      }} />
    <Link
      to={`/${path}`.replace('//', '/')}
      className={`nav-link ${rootClassName(path)}`}
      {...createTooltip(text)}
      onClick={clearSidebar}
      style={{ flex: 1, marginLeft: 4 }}
    >
      <CustomIcon icon={icon} />{" "}
      <span style={{ marginTop: "4px" }}>
        {!openedSidebar
          ? ""
          : title
            ? firstLetterUppercase(title)
            : firstLetterUppercase(path)}
      </span>
    </Link>
    <i className="fas fa-eye nav-item-eye ms-auto" onClick={removeShortcut} />
  </li>
}