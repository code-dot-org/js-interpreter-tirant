import React, {Component} from 'react';
import PropTypes from 'prop-types';
import RunCard from '../components/RunCard';
import VersionSwitcher from '../components/VersionSwitcher';

export default class FrontPage extends Component {
  static propTypes = {};

  render() {
    return (
      <div className="row">
        <div className="col s12 m6">
          <VersionSwitcher />
        </div>
        <div className="col s12 m6">
          <RunCard />
        </div>
      </div>
    );
  }
}