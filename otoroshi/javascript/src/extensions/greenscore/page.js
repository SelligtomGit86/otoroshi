import React, { useEffect, useState } from 'react';
import * as BackOfficeServices from '../../services/BackOfficeServices';
import { nextClient } from '../../services/BackOfficeServices';
import { Table } from '../../components/inputs/Table';
import { v4 as uuid } from 'uuid';
import { calculateGreenScore, getRankAndLetterFromScore } from './util';
import GreenScoreRoutesForm from './routesForm';

export default class GreenScoreConfigsPage extends React.Component {

    state = {
        routes: [],
        rulesTemplate: undefined
    }

    formSchema = {
        _loc: {
            type: 'location'
        },
        id: {
            type: 'string',
            disabled: true,
            label: 'Id',
            props: {
                placeholder: '---'
            }
        },
        name: {
            type: 'string',
            label: 'Group name',
            props: {
                placeholder: 'My Awesome Green Score group'
            },
        },
        description: {
            type: 'string',
            label: 'Description',
            props: {
                placeholder: 'Description of the Green Score config'
            },
        },
        metadata: {
            type: 'object',
            label: 'Metadata'
        },
        tags: {
            type: 'array',
            label: 'Tags'
        },
        routes: {
            renderer: props => <GreenScoreRoutesForm {...props} routeEntities={this.state.routes} rulesTemplate={this.state.rulesTemplate} />
        }
    };

    columns = [
        {
            title: 'Name',
            filterId: 'name',
            content: (item) => item.name,
        },
        {
            title: 'Description',
            filterId: 'description',
            content: (item) => item.description
        },
        {
            title: 'Green score group',
            notFilterable: true,
            content: GreenScoreColumm
        },
        {
            title: 'Dynamic score',
            notFilterable: true,
            Cell: DynamicScoreColumn
        }
    ];

    formFlow = [
        '_loc',
        {
            type: 'group',
            name: 'Informations',
            collapsed: false,
            fields: [
                'id',
                'name',
                'description'
            ]
        },
        {
            type: 'group',
            name: 'Routes',
            collapsed: false,
            fields: ['routes']
        },
        {
            type: 'group',
            name: 'Misc.',
            collapsed: true,
            fields: ['tags', 'metadata'],
        }
    ];

    componentDidMount() {
        this.props.setTitle(`All Green Score configs.`);

        nextClient.forEntity(nextClient.ENTITIES.ROUTES)
            .findAll()
            .then(routes => this.setState({ routes }))

        fetch("/bo/api/proxy/api/extensions/green-score/template", {
            credentials: 'include',
            headers: {
                Accept: 'application/json',
            },
        })
            .then(r => r.json())
            .then(rulesTemplate => this.setState({
                rulesTemplate
            }))
    }

    render() {
        const client = BackOfficeServices.apisClient('green-score.extensions.otoroshi.io', 'v1', 'green-scores');

        return (
            <Table
                parentProps={this.props}
                selfUrl="extensions/green-score/green-score-configs"
                defaultTitle="All Green Score configs."
                defaultValue={() => ({
                    id: 'green-score-config_' + uuid(),
                    name: 'My Green Score',
                    description: 'An awesome Green Score',
                    tags: [],
                    metadata: {},
                    routes: [],
                    config: {

                    }
                })}
                itemName="Green Score config"
                formSchema={this.formSchema}
                formFlow={this.formFlow}
                columns={this.columns}
                stayAfterSave={true}
                fetchItems={client.findAll}
                updateItem={client.update}
                deleteItem={client.delete}
                createItem={client.create}
                navigateTo={(item) => {
                    window.location = `/bo/dashboard/extensions/green-score/green-score-configs/edit/${item.id}`
                }}
                itemUrl={(item) => `/bo/dashboard/extensions/green-score/green-score-configs/edit/${item.id}`}
                showActions={true}
                showLink={true}
                rowNavigation={true}
                extractKey={(item) => item.id}
                export={true}
                kubernetesKind={"GreenScore"}
            />
        );
    }
}

const GreenScoreColumm = props => {
    const score = props
        .routes
        .reduce((acc, route) => calculateGreenScore(route.rulesConfig).score + acc, 0) / props.routes.length;

    const { letter, rank } = getRankAndLetterFromScore(score)

    return <div className='text-center'>
        {letter} <i className="fa fa-leaf" style={{ color: rank }} />
    </div>
}

const DynamicScoreColumn = (props) => {
    const [score, setScore] = useState(undefined)
    const greenScoreId = props.value.id;

    useEffect(() => {
        fetch(`/bo/api/proxy/api/extensions/green-score/${greenScoreId}`, {
            credentials: 'include',
            headers: {
                Accept: 'application/json',
            },
        })
            .then(r => r.json())
            .then(setScore)
    }, [])

    console.log(score)
    return <div></div>
    // return <div className='text-center'>{JSON.stringify(score, null, 4)}</div>
}